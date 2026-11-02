import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SendTurnInput } from "../src/integrations/harness/core/types";
import type { HostProvider } from "./providers";
import { HostEngine } from "./engine";
import { HostStore } from "./store";
import { HostAppAccess, operatorInstructions } from "./app-access";
import { childEnv } from "./session-env";
import { jobWorktreePath, worktreeRoot, createJobWorktree } from "./worktrees-root";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Turn = { input: SendTurnInput; finish: () => void; env: NodeJS.ProcessEnv };
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function host(directory = mkdtempSync(join(tmpdir(), "monocode-operator-test-"))) {
  const store = new HostStore(join(directory, "host.db"));
  const project = store.addProject(directory, "Test");
  const turns: Turn[] = [];
  const provider: HostProvider = {
    send: vi.fn(
      (input) =>
        new Promise<void>((resolve) => {
          // What a child spawned for this turn would see.
          turns.push({ input, finish: resolve, env: childEnv(input.sessionId, {}) });
        }),
    ),
    cancel: vi.fn(async (id: string) => {
      turns.filter((t) => t.input.sessionId === id).forEach((t) => t.finish());
    }),
    stop: vi.fn(async (id: string) => {
      turns.filter((t) => t.input.sessionId === id).forEach((t) => t.finish());
    }),
    bind: vi.fn(),
    approve: vi.fn(),
    answer: vi.fn(),
  };
  const engine = new HostEngine(store, { claude: provider, codex: provider });
  const app = new HostAppAccess(engine, {
    cli: "/opt/monocode/bin/monocode",
    providers: () => ["claude", "codex"],
    models: async () => ({
      models: {
        claude: [{ id: "claude:test", harness: "claude", name: "Test" }],
        codex: [{ id: "codex:gpt", harness: "codex", name: "GPT" }],
      },
      errors: {},
    }),
  });
  app.listen("http://127.0.0.1:1/app");
  const close = async () => {
    app.close();
    await engine.close();
    store.close();
  };
  return { directory, store, project, engine, app, turns, close };
}

function setup() {
  const h = host();
  cleanups.push(async () => {
    await h.close();
    rmSync(h.directory, { recursive: true, force: true });
  });
  return h;
}

function newSession(h: ReturnType<typeof host>) {
  return h.engine.command({
    type: "create",
    commandId: `create-${Math.random()}`,
    projectId: h.project.id,
    harness: "claude",
    model: "claude:test",
    runtimeMode: "supervised",
  }).sessionId;
}

function send(h: ReturnType<typeof host>, sessionId: string, text: string) {
  h.engine.command({ type: "send", commandId: `send-${Math.random()}`, sessionId, text });
}

const turnOf = (h: ReturnType<typeof host>, id: string) =>
  h.turns.filter((t) => t.input.sessionId === id).at(-1)!;

function answer(turn: Turn, text: string) {
  turn.input.onEvent({ type: "message.delta", text });
  turn.input.onEvent({ type: "message.completed" });
  turn.finish();
}

/** Starts an /operator lead turn and returns its app token. */
async function lead(h: ReturnType<typeof host>) {
  const id = newSession(h);
  send(h, id, "/operator plan the work");
  await settle();
  const turn = turnOf(h, id);
  return { id, turn, token: turn.env.MONOCODE_APP_TOKEN! };
}

describe("operator app access", () => {
  it("injects instructions and a token only into /operator turns", async () => {
    const h = setup();
    const { id, turn, token } = await lead(h);
    expect(turn.input.text).toBe(operatorInstructions("/opt/monocode/bin/monocode") + "plan the work");
    expect(turn.input.appAccess).toBe(true);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(turn.env.MONOCODE).toBe("/opt/monocode/bin/monocode");
    const block = h.store.session(id).session.blocks.at(-1)!;
    expect(block).toMatchObject({ role: "user", text: "plan the work", monocode: true });

    const worker = newSession(h);
    send(h, worker, "plain work");
    await settle();
    const workerTurn = turnOf(h, worker);
    expect(workerTurn.env.MONOCODE_APP_TOKEN).toBeUndefined();
    expect(workerTurn.input.appAccess).toBeUndefined();
    // Inherited host variables never reach a worker either.
    expect(childEnv(worker, { MONOCODE_APP_TOKEN: "x", MONOCODE_APP_URL: "y" })).not.toHaveProperty(
      "MONOCODE_APP_TOKEN",
    );
    await expect(h.app.call(undefined, "app.sessions.list", {})).rejects.toThrow(/not enabled/);
    await expect(h.app.call("x".repeat(43), "app.sessions.list", {})).rejects.toThrow(/not enabled/);

    // Later turns of the thread keep access without repeating the instructions.
    answer(turn, "ok");
    await settle();
    expect(h.app.tokens.caller(token)).toBeUndefined();
    send(h, id, "continue");
    await settle();
    const later = turnOf(h, id);
    expect(later.input.text).toBe("continue");
    expect(later.env.MONOCODE_APP_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(later.env.MONOCODE_APP_TOKEN).not.toBe(token);
  });

  it("refuses /operator when app access is not listening", async () => {
    const directory = mkdtempSync(join(tmpdir(), "monocode-operator-test-"));
    const store = new HostStore(join(directory, "host.db"));
    const project = store.addProject(directory, "Test");
    const engine = new HostEngine(store, {});
    cleanups.push(async () => {
      await engine.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const provider = { send: vi.fn(), cancel: vi.fn(), stop: vi.fn(), bind: vi.fn(), approve: vi.fn(), answer: vi.fn() };
    const e2 = new HostEngine(store, { claude: provider as unknown as HostProvider });
    const id = e2.command({
      type: "create", commandId: "c", projectId: project.id, harness: "claude", model: "claude:test", runtimeMode: "supervised",
    }).sessionId;
    expect(() => e2.command({ type: "send", commandId: "s", sessionId: id, text: "/operator go" })).toThrow(
      /Operator mode is unavailable/,
    );
  });

  it("binds each token to its own session and project", async () => {
    const h = setup();
    const a = await lead(h);
    const b = await lead(h);
    const started = (await h.app.call(a.token, "app.sessions.start", {
      prompt: "task one",
      harness: "claude",
    })) as { sessionId: string };
    expect(started.sessionId).toMatch(new RegExp(`^app-${a.id}-[0-9a-f]{8}$`));
    const listedByB = (await h.app.call(b.token, "app.sessions.list", {})) as Array<{ id: string; startedByYou: boolean }>;
    expect(listedByB.find((s) => s.id === started.sessionId)?.startedByYou).toBe(false);
    expect(listedByB.some((s) => s.id === b.id)).toBe(false);
    // B's token acts as B: a launch from it belongs to B, never to A.
    const fromB = (await h.app.call(b.token, "app.sessions.start", { prompt: "task two" })) as { sessionId: string };
    expect(fromB.sessionId.startsWith(`app-${b.id}-`)).toBe(true);
    expect(h.app.reports.pending().get(fromB.sessionId)).toBe(b.id);
    // A worker cannot be given operator access by its lead.
    await expect(
      h.app.call(a.token, "app.sessions.start", { prompt: "/operator escalate" }),
    ).rejects.toThrow(/cannot enable \/operator/);
    // The worker's own turn has no credential.
    await settle();
    expect(turnOf(h, started.sessionId).env.MONOCODE_APP_TOKEN).toBeUndefined();
    // Another project's sessions are out of reach.
    const other = h.store.addProject(join(h.directory, "other"), "Other");
    const foreign = h.engine.command({
      type: "create", commandId: "f", projectId: other.id, harness: "claude", model: "claude:test", runtimeMode: "supervised",
    }).sessionId;
    await expect(h.app.call(a.token, "app.sessions.read", { sessionId: foreign })).rejects.toThrow(/not found/);
    await expect(h.app.call(a.token, "app.sessions.stop", { sessionId: a.id })).rejects.toThrow(/own turn/);
  });

  it("revokes a token when its session is deleted", async () => {
    const h = setup();
    const a = await lead(h);
    expect(h.app.tokens.caller(a.token)).toBe(a.id);
    // Deleting needs a stopped session; force the record away underneath.
    h.engine.hooks.sessionDeleted!(a.id);
    expect(h.app.tokens.caller(a.token)).toBeUndefined();
    await expect(h.app.call(a.token, "app.sessions.list", {})).rejects.toThrow(/not enabled/);
  });

  it("validates start settings", async () => {
    const h = setup();
    const a = await lead(h);
    await expect(h.app.call(a.token, "app.sessions.start", { prompt: "x", harness: "grok" })).rejects.toThrow(/harness/);
    await expect(h.app.call(a.token, "app.sessions.start", { prompt: "x", model: "nope" })).rejects.toThrow(/Unknown model/);
    await expect(h.app.call(a.token, "nope", {})).rejects.toThrow(/Unknown action/);
    // Lead-only methods exist only under the app. prefix.
    await expect(h.app.call(a.token, "sessions.list", {})).rejects.toThrow(/Unknown action/);
    // Accounts are resolved by the engine: an unknown one is refused, never replaced.
    await expect(
      h.app.call(a.token, "app.sessions.start", { prompt: "x", harness: "codex", account: "claude-alt-3" }),
    ).rejects.toThrow(/account/i);
    const started = (await h.app.call(a.token, "app.sessions.start", {
      prompt: "x",
      harness: "codex",
      effort: "high",
      title: "Worker one",
      runtimeMode: "full-access",
    })) as { sessionId: string };
    const value = h.store.session(started.sessionId);
    expect(value.session).toMatchObject({
      harness: "codex",
      model: "codex:gpt",
      runtimeMode: "full-access",
      title: "Worker one",
      modelSettings: { reasoningEffort: "high" },
    });
  });
});

describe("operator reports", () => {
  it("reports once, after both children stop and the lead is idle; a cancelled child drops out", async () => {
    const h = setup();
    const a = await lead(h);
    const one = (await h.app.call(a.token, "app.sessions.start", { prompt: "one", title: "First" })) as { sessionId: string };
    const two = (await h.app.call(a.token, "app.sessions.start", { prompt: "two", title: "Second" })) as { sessionId: string };
    expect([...h.app.reports.pending().keys()].sort()).toEqual([one.sessionId, two.sessionId].sort());
    answer(a.turn, "Started two workers.");
    await settle();
    answer(turnOf(h, one.sessionId), "First result");
    await settle();
    // One child still running: no report yet.
    expect(h.turns.filter((t) => t.input.sessionId === a.id)).toHaveLength(1);
    // The owner cancels the second child; it drops out of the batch.
    const second = h.store.session(two.sessionId);
    h.engine.command({ type: "cancel", commandId: "cancel-2", sessionId: two.sessionId, runId: second.runId! });
    await settle();
    const leadTurns = h.turns.filter((t) => t.input.sessionId === a.id);
    expect(leadTurns).toHaveLength(2);
    const report = leadTurns[1].input.text;
    expect(report.startsWith("[Delegated work completed]\nThe session you started has stopped.")).toBe(true);
    expect(report).toContain(`Session ${one.sessionId}: First\nFirst result`);
    expect(report).not.toContain(two.sessionId);
    expect(h.app.reports.pending().size).toBe(0);
    // It arrives as a normal turn of the lead, which keeps app access.
    expect(leadTurns[1].env.MONOCODE_APP_TOKEN).toBeDefined();
    answer(leadTurns[1], "Integrated update");
    await settle();
    expect(h.turns.filter((t) => t.input.sessionId === a.id)).toHaveLength(2);
  });

  it("waits for a busy lead and batches every child into one message", async () => {
    const h = setup();
    const a = await lead(h);
    const one = (await h.app.call(a.token, "app.sessions.start", { prompt: "one" })) as { sessionId: string };
    const two = (await h.app.call(a.token, "app.sessions.start", { prompt: "two" })) as { sessionId: string };
    answer(turnOf(h, one.sessionId), "A");
    answer(turnOf(h, two.sessionId), "B");
    await settle();
    expect(h.turns.filter((t) => t.input.sessionId === a.id)).toHaveLength(1);
    answer(a.turn, "done dispatching");
    await settle();
    const leadTurns = h.turns.filter((t) => t.input.sessionId === a.id);
    expect(leadTurns).toHaveLength(2);
    expect(leadTurns[1].input.text).toContain("All sessions you started have stopped.");
    expect(leadTurns[1].input.text).toContain(`Session ${one.sessionId}:`);
    expect(leadTurns[1].input.text).toContain(`Session ${two.sessionId}:`);
  });

  it("drops a child the lead stops itself", async () => {
    const h = setup();
    const a = await lead(h);
    const one = (await h.app.call(a.token, "app.sessions.start", { prompt: "one" })) as { sessionId: string };
    expect(await h.app.call(a.token, "app.sessions.stop", { sessionId: one.sessionId })).toEqual({
      sessionId: one.sessionId,
      stopped: true,
    });
    await settle();
    answer(a.turn, "ok");
    await settle();
    expect(h.turns.filter((t) => t.input.sessionId === a.id)).toHaveLength(1);
    expect(h.app.reports.pending().size).toBe(0);
  });

  it("keeps pending reports across a host restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "monocode-operator-test-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const first = host(directory);
    const a = await lead(first);
    const one = (await first.app.call(a.token, "app.sessions.start", { prompt: "one", title: "Survivor" })) as { sessionId: string };
    answer(a.turn, "dispatched");
    await settle();
    turnOf(first, one.sessionId).input.onEvent({ type: "message.delta", text: "Partial work" });
    await settle();
    // The host stops while the child works; the report must survive.
    await first.close();
    const second = host(directory);
    cleanups.push(() => second.close());
    await settle();
    const leadTurns = second.turns.filter((t) => t.input.sessionId === a.id);
    expect(leadTurns).toHaveLength(1);
    expect(leadTurns[0].input.text).toContain(`Session ${one.sessionId}: Survivor`);
    expect(second.app.reports.pending().size).toBe(0);
  });

  it("forgets reports for a deleted lead", async () => {
    const h = setup();
    const a = await lead(h);
    await h.app.call(a.token, "app.sessions.start", { prompt: "one" });
    answer(a.turn, "ok");
    await settle();
    h.engine.deleteSession(a.id);
    expect(h.app.reports.pending().size).toBe(0);
  });
});

describe("worker worktrees", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", ...args], { cwd, stdio: "pipe" });

  it("puts job worktrees beside the workspace or under the configured root", () => {
    expect(worktreeRoot("/srv/trade", {})).toBe("/srv/trade-worktrees");
    expect(worktreeRoot("/srv/trade", { MONOCODE_HOST_WORKTREE_ROOT: "/data/wt" })).toBe("/data/wt");
    expect(() => worktreeRoot("/srv/trade", { MONOCODE_HOST_WORKTREE_ROOT: "rel" })).toThrow(/absolute/);
    expect(jobWorktreePath("/srv/trade-worktrees", "p2-operator")).toBe("/srv/trade-worktrees/p2-operator");
    for (const bad of ["../x", "a/b", "..", ".", "a\\b", "", "-x", "x..y", "/abs", 3])
      expect(() => jobWorktreePath("/srv/trade-worktrees", bad)).toThrow();
  });

  it("creates a worktree from a base ref through the app API", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "monocode-operator-wt-")));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    const repo = join(base, "trade");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "a");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "init");
    const created = await createJobWorktree({ workspace: repo, job: "job-1", base: "main", env: {} });
    expect(created).toMatchObject({ path: join(base, "trade-worktrees", "job-1"), branch: "job-1" });
    await expect(createJobWorktree({ workspace: repo, job: "job-1", env: {} })).rejects.toThrow(/exists/);
    await expect(createJobWorktree({ workspace: repo, job: "job-2", base: "nope", env: {} })).rejects.toThrow(
      /not a commit/,
    );
    await expect(createJobWorktree({ workspace: repo, job: "j3", base: "--all", env: {} })).rejects.toThrow(
      /Invalid base/,
    );
    await expect(createJobWorktree({ workspace: repo, job: "../escape", env: {} })).rejects.toThrow(/folder name/);
    const root = join(base, "custom");
    const configured = await createJobWorktree({
      workspace: repo,
      job: "job-4",
      env: { MONOCODE_HOST_WORKTREE_ROOT: root },
    });
    expect(configured.path).toBe(join(root, "job-4"));
  });
});
