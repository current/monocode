import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isRemoteProvider,
  type HostModelCatalog,
  type HostSession,
  type RemoteProvider,
} from "../src/features/connections/model/protocol";
import { RUNTIME_MODES, type RuntimeMode } from "../src/features/sessions/model/session";
import { consumeOperatorCommand } from "../src/features/sessions/model/operatorCommand";
import type { HostEngine } from "./engine";
import { OperatorReports, finalAnswer, limitText } from "./operator-reports";
import { clearSessionEnv, setSessionEnv } from "./session-env";
import { createJobWorktree, worktreeRoot } from "./worktrees-root";
import { hostWorktrees } from "./git-worktrees";

/**
 * Account choice for launched sessions. `host/accounts.ts` (owned by the
 * accounts work) exports `resolveAccount(harness, wanted)`; until it is wired
 * here, the wanted label passes through unchanged as the session setting
 * `account`. A resolver throws for an unknown or exhausted account; it never
 * substitutes another one.
 */
export type AccountResolver = (
  harness: RemoteProvider,
  wanted: string | undefined,
) => string | undefined | Promise<string | undefined>;

export const passThroughAccount: AccountResolver = (_harness, wanted) => wanted;

export const OPERATOR_ACTIONS = [
  "models.list",
  "sessions.list",
  "sessions.read",
  "sessions.start",
  "sessions.send",
  "sessions.stop",
  "worktrees.list",
  "worktrees.create",
] as const;
type Action = (typeof OPERATOR_ACTIONS)[number];
/** Lead-only host methods are named `app.*` on the wire. The desk bridge
 * refuses every `app.` method, and the device RPC has none, so only a
 * session token on `POST /app` reaches them. */
export const APP_METHOD_PREFIX = "app.";
export const appMethod = (action: string) =>
  action.startsWith(APP_METHOD_PREFIX) ? action : `${APP_METHOD_PREFIX}${action}`;

const MAX_BODY = 512 * 1024;
const EFFORT_KEYS = ["effort", "reasoningEffort", "reasoning", "reasoning_effort", "variant"];

/** Per-turn credentials for /operator leads. A token is bound to one session
 * and lives only while that session's turn runs; deleting the session or
 * settling the turn revokes it. Only hashes are kept. */
export class AppTokens {
  private byHash = new Map<string, string>();
  private bySession = new Map<string, string>();

  private hash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  issue(sessionId: string): string {
    this.revoke(sessionId);
    const token = randomBytes(32).toString("base64url");
    const hash = this.hash(token);
    this.byHash.set(hash, sessionId);
    this.bySession.set(sessionId, hash);
    return token;
  }

  caller(token: unknown): string | undefined {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    return this.byHash.get(this.hash(token));
  }

  revoke(sessionId: string): void {
    const hash = this.bySession.get(sessionId);
    if (hash) this.byHash.delete(hash);
    this.bySession.delete(sessionId);
  }
}

const fail = (message: string): never => {
  throw new Error(message);
};

function str(input: Record<string, unknown>, key: string, max: number): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
    fail(`Provide ${key} (up to ${max} characters).`);
  return (value as string).trim();
}

function optionalStr(input: Record<string, unknown>, key: string, max: number): string | undefined {
  return input[key] === undefined || input[key] === null ? undefined : str(input, key, max);
}

/** Server account ids (`claude-alt-3`) or labels (`Claude (alt-3)`), unchanged. */
function rawAccount(input: Record<string, unknown>): string | undefined {
  if (input.account === undefined || input.account === null) return undefined;
  const value = input.account;
  if (typeof value !== "string" || !value.trim() || value.length > 128 || value.includes("\0"))
    fail("Provide account (up to 128 characters).");
  return value as string;
}

function prompt(input: Record<string, unknown>): string {
  const text = str(input, "prompt", 240_000);
  if (consumeOperatorCommand(text).matched)
    fail("App calls cannot enable /operator in another session");
  return text;
}

/** The instructions an /operator turn carries, with the exact CLI path. */
export function operatorInstructions(cli: string): string {
  const q = cli.includes(" ") ? `"${cli}"` : cli;
  return `<monocode_app>
The user's Operator command enables app access in this thread, including later turns without the command. You can start worker sessions in this project, list them, read their transcripts, continue or stop them, list the models each harness offers, and create a git worktree per worker, through the host's app CLI:

  ${q} app ACTION --json '<JSON>'     (also available as "$MONOCODE" app ...)

Actions (host methods app.<action>; the CLI adds the prefix): models.list {}; sessions.list {includeArchived?}; sessions.read {sessionId, exchanges?, before?}; sessions.start {prompt, harness, account?, model?, effort?, title?, runtimeMode?, worktreeCwd?}; sessions.send {sessionId, prompt}; sessions.stop {sessionId}; worktrees.list {}; worktrees.create {job, base?, branch?}. Run \`${q} app --help\` for details.
The CLI uses a session credential already in your environment; never print it. New sessions inherit this session's model and permission mode unless model or runtimeMode is set. Sessions you start cannot start sessions themselves. A sessions.start returns once the host accepts the turn; do not wait or poll for workers. End your turn instead: when you are idle and every session you started has stopped, you receive one "[Delegated work completed]" message with their final answers. When reading another session, start with its latest two or three exchanges and ask for older ones with "before" only if needed.
</monocode_app>

`;
}

export const APP_HELP = `MonoCode app CLI (operator sessions only)
  app ACTION --json JSON

  models.list       {}
  sessions.list     {"includeArchived"?: boolean}
  sessions.read     {"sessionId", "exchanges"?: 1-20 (default 3), "before"?: exchange index}
  sessions.start    {"prompt", "harness", "account"?, "model"?, "effort"?, "title"?,
                     "runtimeMode"?, "worktreeCwd"?}
  sessions.send     {"sessionId", "prompt"}
  sessions.stop     {"sessionId"}
  worktrees.list    {}
  worktrees.create  {"job", "base"?: ref (default HEAD), "branch"?: name (default job)}

Each ACTION is the host method app.ACTION (the prefix is optional here).
Uses MONOCODE_APP_URL and MONOCODE_APP_TOKEN from the operator session's environment.`;

/** \`monocode-host app ACTION --json JSON\`, run by an agent inside its turn. */
export async function runAppCli(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  out: (text: string) => void = (text) => console.log(text),
): Promise<number> {
  const action = args[0];
  if (!action || action === "help" || action === "--help") {
    out(APP_HELP);
    return 0;
  }
  const jsonIndex = args.indexOf("--json");
  let input: unknown = {};
  if (jsonIndex >= 0) {
    const raw = args[jsonIndex + 1];
    if (raw === undefined) throw new Error("Missing --json value");
    input = JSON.parse(raw);
  }
  const url = env.MONOCODE_APP_URL;
  const token = env.MONOCODE_APP_TOKEN;
  if (!url || !token)
    throw new Error(
      "App access is not enabled in this session. Only an /operator session's turn can use the app CLI.",
    );
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action: appMethod(action), input }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = (await response.json()) as { result?: unknown; error?: string };
  if (!response.ok || body.error) throw new Error(body.error ?? `App call failed (${response.status})`);
  out(JSON.stringify(body.result ?? null, null, 2));
  return 0;
}

/** Writes `<data>/bin/monocode`, a launcher for the app CLI, on POSIX hosts. */
export function installAppLauncher(directory: string, node: string, entry: string): string {
  if (process.platform === "win32") return `"${node}" "${entry}"`;
  const bin = join(directory, "bin");
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  const path = join(bin, "monocode");
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  writeFileSync(path, `#!/bin/sh\nexec ${quote(node)} ${quote(entry)} "$@"\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

type Exchange = { index: number; user: string; assistant: string };

function exchanges(value: HostSession): Exchange[] {
  const list: Exchange[] = [];
  let current: Exchange | undefined;
  for (const block of value.session.blocks) {
    if (block.draft || block.internal) continue;
    if (block.role === "user") {
      current = { index: list.length, user: block.text, assistant: "" };
      list.push(current);
    } else if (block.role === "assistant" && current && block.text.trim()) {
      current.assistant = current.assistant
        ? `${current.assistant}\n\n${block.text.trim()}`
        : block.text.trim();
    }
  }
  return list;
}

export class HostAppAccess {
  readonly tokens = new AppTokens();
  readonly reports: OperatorReports;
  private url?: string;

  constructor(
    private readonly engine: HostEngine,
    private readonly options: {
      /** The command an agent runs (see installAppLauncher). */
      cli: string;
      /** The host's model catalog; the server supplies it (useModels). */
      models?: (projectId: string) => Promise<HostModelCatalog>;
      providers: () => RemoteProvider[];
      resolveAccount?: AccountResolver;
      env?: NodeJS.ProcessEnv;
    },
  ) {
    this.reports = new OperatorReports(engine.store, {
      isRunning: (id) => engine.isRunning(id),
      deliver: (leadId, text, commandId) => {
        engine.command({ type: "send", commandId, sessionId: leadId, text });
      },
    });
    engine.hooks = {
      operator: false,
      operatorTurnStarting: (value, text, operatorTurn) => {
        const id = value.session.id;
        if (!this.url) return text;
        setSessionEnv(id, {
          MONOCODE: this.options.cli,
          MONOCODE_APP_URL: this.url,
          MONOCODE_APP_TOKEN: this.tokens.issue(id),
        });
        return operatorTurn ? operatorInstructions(this.options.cli) + text : text;
      },
      turnSettled: (value, outcome) => {
        const id = value.session.id;
        this.tokens.revoke(id);
        clearSessionEnv(id);
        if (outcome.cancelled) this.reports.dismiss(id);
        this.reports.check();
      },
      sessionDeleted: (id) => {
        this.tokens.revoke(id);
        clearSessionEnv(id);
        this.reports.forgetLead(id);
        this.reports.dismiss(id);
        this.reports.check();
      },
    };
  }

  useModels(models: (projectId: string) => Promise<HostModelCatalog>): void {
    this.options.models = models;
  }

  private catalog(projectId: string): Promise<HostModelCatalog> {
    return this.options.models
      ? this.options.models(projectId)
      : Promise.resolve({ models: {}, errors: {} });
  }

  /** Enables operator mode once the host listens for app calls. */
  listen(url: string): void {
    this.url = url;
    this.engine.hooks.operator = true;
    // Reports that were waiting when the host stopped.
    this.reports.check();
  }

  close(): void {
    this.reports.close();
  }

  /** Serves `POST /app` (loopback, bearer = the session's app token). */
  async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    try {
      if (request.method !== "POST" || request.headers.origin) {
        response.writeHead(403).end(JSON.stringify({ error: "Unsupported request" }));
        return;
      }
      const token = request.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
      if (!this.tokens.caller(token)) {
        response.writeHead(401).end(
          JSON.stringify({ error: "App access is not enabled for this session" }),
        );
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY) throw new Error("Request is too large");
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      const result = await this.call(token, body?.action, body?.input ?? {});
      response.end(JSON.stringify({ result }));
    } catch (error) {
      if (!response.destroyed)
        response.writeHead(400).end(
          JSON.stringify({ error: error instanceof Error ? error.message : "App call failed" }),
        );
    }
  }

  /** One app call by the session the token belongs to. */
  async call(token: unknown, action: unknown, rawInput: unknown): Promise<unknown> {
    const caller = this.tokens.caller(token);
    if (!caller) throw new Error("App access is not enabled for this session");
    const name =
      typeof action === "string" && action.startsWith(APP_METHOD_PREFIX)
        ? action.slice(APP_METHOD_PREFIX.length)
        : undefined;
    if (!name || !OPERATOR_ACTIONS.includes(name as Action))
      throw new Error(
        `Unknown action. Use one of: ${OPERATOR_ACTIONS.map(appMethod).join(", ")}`,
      );
    if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput))
      throw new Error("Input must be a JSON object");
    const input = rawInput as Record<string, unknown>;
    const lead = this.engine.store.session(caller);
    switch (name as Action) {
      case "models.list":
        return this.modelsList(lead);
      case "sessions.list":
        return this.engine.store
          .summaries(lead.projectId)
          .filter((s) => s.id !== caller && (input.includeArchived === true || !s.archived))
          .slice(0, 200)
          .map((s) => ({
            id: s.id,
            title: s.title,
            harness: s.harness,
            model: s.model,
            status: s.status,
            needsInput: s.needsInput,
            archived: s.archived ?? false,
            updatedAt: s.updatedAt,
            startedByYou: s.id.startsWith(`app-${caller}-`),
          }));
      case "sessions.read":
        return this.read(lead, input);
      case "sessions.start":
        return this.start(lead, input);
      case "sessions.send": {
        const target = this.target(lead, input);
        const text = prompt(input);
        if (target.status === "running" || this.engine.isRunning(target.session.id))
          throw new Error("That session is running; wait for its report or stop it first");
        this.reports.track(target.session.id, caller);
        try {
          this.engine.command({
            type: "send",
            commandId: randomUUID(),
            sessionId: target.session.id,
            text,
          });
        } catch (error) {
          this.reports.dismiss(target.session.id);
          throw error;
        }
        return { sessionId: target.session.id, accepted: true };
      }
      case "sessions.stop": {
        const target = this.target(lead, input);
        // The lead stopped it itself; it already knows.
        this.reports.dismiss(target.session.id);
        if (target.status !== "running" || !target.runId)
          return { sessionId: target.session.id, stopped: false };
        this.engine.command({
          type: "cancel",
          commandId: randomUUID(),
          sessionId: target.session.id,
          runId: target.runId,
        });
        return { sessionId: target.session.id, stopped: true };
      }
      case "worktrees.list": {
        const project = this.engine.store.project(lead.projectId);
        const listed = await hostWorktrees(project.cwd);
        return {
          root: worktreeRoot(project.cwd, this.options.env),
          worktrees: listed.worktrees.map(({ path, branch, isMain, missing }) => ({
            path,
            branch,
            isMain,
            missing,
          })),
        };
      }
      case "worktrees.create": {
        const project = this.engine.store.project(lead.projectId);
        const created = await createJobWorktree({
          workspace: project.cwd,
          job: input.job,
          base: input.base,
          branch: input.branch,
          env: this.options.env,
        });
        return { path: created.path, branch: created.branch, head: created.head };
      }
    }
  }

  private target(lead: HostSession, input: Record<string, unknown>): HostSession {
    const id = str(input, "sessionId", 256);
    if (id === lead.session.id) throw new Error("Use this session's own turn instead");
    let target: HostSession;
    try {
      target = this.engine.store.session(id);
    } catch {
      throw new Error("Session not found in this project");
    }
    if (target.projectId !== lead.projectId) throw new Error("Session not found in this project");
    return target;
  }

  private async modelsList(lead: HostSession) {
    const catalog = await this.catalog(lead.projectId);
    const providers = this.options.providers();
    return {
      harnesses: providers.map((id) => ({
        id,
        available: true,
        models: (catalog.models[id] ?? []).map((model) => ({
          id: model.id,
          name: model.name,
          settings: (model.settings ?? []).map((setting) => ({
            id: setting.id,
            label: setting.label,
            defaultValue: setting.value,
            options: setting.options,
          })),
        })),
        error: catalog.errors[id],
      })),
      runtimeModes: RUNTIME_MODES,
    };
  }

  private read(lead: HostSession, input: Record<string, unknown>) {
    const target = this.target(lead, input);
    const count =
      input.exchanges === undefined ? 3 : Number(input.exchanges);
    if (!Number.isInteger(count) || count < 1 || count > 20)
      throw new Error("exchanges must be 1-20");
    const all = exchanges(target);
    const before =
      input.before === undefined ? all.length : Number(input.before);
    if (!Number.isInteger(before) || before < 0 || before > all.length)
      throw new Error("Invalid before");
    const start = Math.max(0, before - count);
    return {
      sessionId: target.session.id,
      title: target.session.title,
      status: target.status,
      needsInput: !!target.session.pendingQuestion ||
        target.session.blocks.some((b) => b.approval && !b.approval.decided),
      exchanges: all.slice(start, before).map((e) => ({
        index: e.index,
        user: limitText(e.user, 4_000),
        assistant: limitText(e.assistant, 12_000),
      })),
      finalAnswer: target.status === "running" ? undefined : limitText(finalAnswer(target)),
      nextBefore: start > 0 ? start : null,
    };
  }

  private async start(lead: HostSession, input: Record<string, unknown>) {
    const text = prompt(input);
    const harness = input.harness ?? lead.session.harness;
    if (!isRemoteProvider(harness) || !this.options.providers().includes(harness))
      throw new Error("Unknown or unavailable harness; run models.list");
    const runtimeMode = (input.runtimeMode ?? lead.session.runtimeMode) as RuntimeMode;
    if (!RUNTIME_MODES.includes(runtimeMode)) throw new Error("Invalid runtimeMode");
    const requested = optionalStr(input, "model", 200);
    const catalog =
      requested || harness !== lead.session.harness || input.effort !== undefined
        ? await this.catalog(lead.projectId)
        : undefined;
    const models = catalog?.models[harness] ?? [];
    let model: string;
    if (requested) {
      const full = requested.includes(":") ? requested : `${harness}:${requested}`;
      const found = models.find(
        (m) => m.id === requested || m.id === full || m.nativeId === requested,
      );
      if (!found && models.length) throw new Error("Unknown model; run models.list for exact model IDs");
      model = found?.id ?? full;
    } else if (harness === lead.session.harness) {
      model = lead.session.model;
    } else {
      model = models[0]?.id ?? fail("No models found for that harness; run models.list");
    }
    const settings: Record<string, string> =
      harness === lead.session.harness && model === lead.session.model
        ? { ...(lead.session.modelSettings ?? {}) }
        : {};
    delete settings.account;
    const effort = optionalStr(input, "effort", 64);
    if (effort) {
      const known = models.find((m) => m.id === model)?.settings?.find((s) =>
        EFFORT_KEYS.includes(s.id),
      );
      if (known && !known.options.some((o) => o.value === effort))
        throw new Error(
          `Unknown effort; choose one of ${known.options.map((o) => o.value).join(", ")}`,
        );
      for (const key of EFFORT_KEYS) delete settings[key];
      settings[known?.id ?? (harness === "codex" ? "reasoningEffort" : "effort")] = effort;
    }
    // The engine resolves `account` on create (host/accounts.ts resolveAccount):
    // unknown, wrong-harness or exhausted accounts throw, never substitute.
    const account = await (this.options.resolveAccount ?? passThroughAccount)(
      harness,
      rawAccount(input),
    );
    const title = optionalStr(input, "title", 200);
    const worktreeCwd = optionalStr(input, "worktreeCwd", 4096);
    const id = `app-${lead.session.id}-${randomBytes(4).toString("hex")}`;
    this.engine.command(
      {
        type: "create",
        commandId: randomUUID(),
        projectId: lead.projectId,
        harness,
        model,
        modelSettings: settings,
        runtimeMode,
        ...(account ? { account } : {}),
        ...(worktreeCwd ? { worktreeCwd } : {}),
      },
      { sessionId: id },
    );
    this.reports.track(id, lead.session.id);
    try {
      this.engine.command({ type: "send", commandId: randomUUID(), sessionId: id, text });
      if (title) this.engine.updateSession(id, { title });
    } catch (error) {
      this.reports.dismiss(id);
      throw error;
    }
    const created = this.engine.store.session(id);
    return {
      sessionId: id,
      title: created.session.title,
      harness,
      model,
      runtimeMode,
      cwd: created.session.cwd,
    };
  }
}
