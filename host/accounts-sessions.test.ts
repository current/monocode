// Acceptance: a host with a two-account registry runs two sessions whose
// spawned CLI environments differ only in the account's config directory.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostChildBackend } from "./child-backend";
import { HostStore } from "./store";
import { HostEngine } from "./engine";
import { hostProviders } from "./providers";
import { configureHostAccounts } from "./accounts";
import {
  acquireHarnessBridge,
  configureChildBackend,
} from "../src/integrations/harness/core/child";

const fixtureHome = vi.hoisted(() => ({ path: "" }));
vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, homedir: () => fixtureHome.path };
});

// A fake Claude/Codex CLI. Each process records a digest of every environment
// variable (never the values) plus the two account variables in clear.
const fixture = `#!/usr/bin/env node
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const env = {};
for (const [key, value] of Object.entries(process.env))
  env[key] = createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
fs.appendFileSync(path.join(__dirname, 'env.log'), JSON.stringify({
  pid: process.pid,
  codex: process.argv.includes('app-server'),
  env,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null,
  CODEX_HOME: process.env.CODEX_HOME ?? null,
}) + '\\n');
if (process.argv.includes('--no-session-persistence') && !process.argv.includes('--session-id')) send({type: 'system', subtype: 'init', session_id: 'fixture-claude'});
require('node:readline').createInterface({input: process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') send({id: request.id, result: {}});
  if (request.method === 'account/read') send({id: request.id, result: {account: {type: 'fixture'}, requiresOpenaiAuth: false}});
  if (request.method === 'thread/start' || request.method === 'thread/resume') send({id: request.id, result: {thread: {id: 'fixture-thread'}}});
  if (request.method === 'turn/start') {
    send({id: request.id, result: {turn: {id: 'fixture-turn'}}});
    setTimeout(() => {
      send({method: 'item/agentMessage/delta', params: {threadId: 'fixture-thread', turnId: 'fixture-turn', itemId: 'message', delta: 'Codex done'}});
      send({method: 'turn/completed', params: {threadId: 'fixture-thread', turn: {id: 'fixture-turn', status: 'completed'}}});
    }, 30);
  }
  if (request.type === 'control_request' && request.request.subtype === 'initialize') {
    send({type: 'system', subtype: 'init', session_id: 'fixture-claude'});
    send({type: 'control_response', response: {subtype: 'success', request_id: request.request_id}});
  } else if (request.type === 'control_request') {
    send({type: 'control_response', response: {subtype: 'success', request_id: request.request_id}});
  }
  if (request.type === 'user') {
    setTimeout(() => {
      send({type: 'assistant', session_id: 'fixture-claude', message: {content: [{type: 'text', text: 'Claude done'}]}});
      send({type: 'result', subtype: 'success', session_id: 'fixture-claude'});
    }, 30);
  }
});
`;

type EnvRecord = {
  pid: number;
  codex: boolean;
  env: Record<string, string>;
  CLAUDE_CONFIG_DIR: string | null;
  CODEX_HOME: string | null;
};

describe("sessions on named host accounts", () => {
  let directory: string;
  let backend: HostChildBackend;
  let release: () => void;
  let store: HostStore;
  let engine: HostEngine;
  let homes: Record<string, string>;

  const records = (): EnvRecord[] =>
    readFileSync(join(directory, "env.log"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

  beforeAll(async () => {
    directory = realpathSync(mkdtempSync(join(tmpdir(), "monocode-accounts-e2e-")));
    fixtureHome.path = directory;
    homes = {};
    for (const id of ["claude-main", "claude-alt", "codex-alt"]) {
      homes[id] = join(directory, "homes", id);
      mkdirSync(homes[id], { recursive: true });
      chmodSync(homes[id], 0o700);
    }
    const registry = join(directory, "accounts.json");
    writeFileSync(
      registry,
      JSON.stringify([
        { id: "claude-main", label: "Claude (main)", harness: "claude", home: homes["claude-main"] },
        { id: "claude-alt", label: "Claude (alt)", harness: "claude", home: homes["claude-alt"] },
        { id: "codex-alt", label: "Codex (alt)", harness: "codex", home: homes["codex-alt"] },
      ]),
      { mode: 0o600 },
    );
    vi.stubEnv("MONOCODE_HOST_ACCOUNTS", registry);
    // The default login is whatever the host itself inherited; start clean.
    vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
    vi.stubEnv("CODEX_HOME", undefined);
    configureHostAccounts({});
    const binary = join(directory, "provider.cjs");
    writeFileSync(join(directory, "env.log"), "");
    writeFileSync(binary, fixture, { mode: 0o700 });
    backend = new HostChildBackend({ claude: binary, codex: binary });
    configureChildBackend(backend);
    release = await acquireHarnessBridge();
    store = new HostStore(join(directory, "host.db"));
    engine = new HostEngine(store, hostProviders);
  });

  afterAll(async () => {
    await engine?.close();
    await backend?.close();
    release?.();
    store?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
    fixtureHome.path = "";
  });

  async function runSession(
    harness: "claude" | "codex",
    account: string | undefined,
    tag: string,
  ): Promise<string> {
    const project = await engine.openProject(directory);
    const { sessionId } = engine.command({
      type: "create",
      commandId: `create-${tag}`,
      projectId: project.id,
      harness,
      model: `${harness}:test`,
      runtimeMode: "supervised",
      ...(account ? { account } : {}),
    });
    engine.command({ type: "send", commandId: `send-${tag}`, sessionId, text: "hello" });
    await vi.waitFor(
      () => expect(store.session(sessionId).status).toBe("idle"),
      { timeout: 5_000 },
    );
    expect(store.session(sessionId).session.blocks.at(-1)?.text).toContain("done");
    return sessionId;
  }

  it("spawns each session's CLI with only its account's config dir changed", async () => {
    const before = records().length;
    const main = await runSession("claude", "Claude (main)", "main");
    const alt = await runSession("claude", "claude-alt", "alt");
    expect(store.session(main).session.providerAccountId).toBe("claude-main");
    expect(store.session(alt).session.providerAccountId).toBe("claude-alt");
    const spawned = records().slice(before).filter((r) => !r.codex);
    const a = spawned.find((r) => r.CLAUDE_CONFIG_DIR === homes["claude-main"]);
    const b = spawned.find((r) => r.CLAUDE_CONFIG_DIR === homes["claude-alt"]);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    const keys = new Set([...Object.keys(a!.env), ...Object.keys(b!.env)]);
    const differing = [...keys].filter((key) => a!.env[key] !== b!.env[key]);
    expect(differing).toEqual(["CLAUDE_CONFIG_DIR"]);
  });

  it("sets CODEX_HOME for a Codex account and nothing for the default login", async () => {
    const before = records().length;
    await runSession("codex", "Codex (alt)", "codex");
    await runSession("claude", undefined, "default");
    const spawned = records().slice(before);
    // The turn's app-server and its title helper both run on the account.
    const codex = spawned.filter((r) => r.codex);
    expect(codex.length).toBeGreaterThan(0);
    for (const record of codex)
      expect(record).toMatchObject({
        CODEX_HOME: homes["codex-alt"],
        CLAUDE_CONFIG_DIR: null,
      });
    const plain = spawned.filter((r) => !r.codex);
    expect(plain.length).toBeGreaterThan(0);
    for (const record of plain) expect(record.CLAUDE_CONFIG_DIR).toBeNull();
  });

  it("refuses unknown and wrong-harness accounts without creating a session", async () => {
    const project = await engine.openProject(directory);
    const count = store.sessions(project.id).length;
    expect(() =>
      engine.command({
        type: "create",
        commandId: "create-unknown",
        projectId: project.id,
        harness: "claude",
        model: "claude:test",
        runtimeMode: "supervised",
        account: "claude-alt-9",
      }),
    ).toThrow(/Unknown claude account "claude-alt-9"/);
    expect(() =>
      engine.command({
        type: "create",
        commandId: "create-wrong",
        projectId: project.id,
        harness: "claude",
        model: "claude:test",
        runtimeMode: "supervised",
        account: "codex-alt",
      }),
    ).toThrow(/is a codex account, not claude/);
    expect(store.sessions(project.id)).toHaveLength(count);
  });

  it("changes the account only before a session has run", async () => {
    const project = await engine.openProject(directory);
    const { sessionId } = engine.command({
      type: "create",
      commandId: "create-configure",
      projectId: project.id,
      harness: "claude",
      model: "claude:test",
      runtimeMode: "supervised",
    });
    const configure = (commandId: string, account: string | null | undefined) =>
      engine.command({
        type: "configure",
        commandId,
        sessionId,
        model: "claude:test",
        modelSettings: {},
        runtimeMode: "supervised",
        ...(account !== undefined ? { account } : {}),
      });
    configure("configure-1", "Claude (alt)");
    expect(store.session(sessionId).session.providerAccountId).toBe("claude-alt");
    configure("configure-2", undefined);
    expect(store.session(sessionId).session.providerAccountId).toBe("claude-alt");
    configure("configure-3", null);
    expect(store.session(sessionId).session.providerAccountId).toBeUndefined();
    configure("configure-4", "claude-main");
    engine.command({ type: "send", commandId: "send-configure", sessionId, text: "hi" });
    await vi.waitFor(
      () => expect(store.session(sessionId).status).toBe("idle"),
      { timeout: 5_000 },
    );
    expect(() => configure("configure-5", "claude-alt")).toThrow(
      /Start a new session to use another account/,
    );
    // Re-sending the same account is not a change.
    configure("configure-6", "Claude (main)");
    expect(store.session(sessionId).session.providerAccountId).toBe("claude-main");
  });
});
