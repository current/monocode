// Named Claude and Codex logins on a MonoCode host.
//
// The owner keeps several subscription logins, each in its own private home:
// a CLAUDE_CONFIG_DIR for Claude, a CODEX_HOME for Codex. The registry lives
// in a JSON file (MONOCODE_HOST_ACCOUNTS, default ~/.monocode-host/accounts.json):
//
//   [{"id": "claude-alt", "label": "Claude (alt)", "harness": "claude",
//     "home": "/srv/monocode/claude-alt"}, ...]
//
// A session that names an account gets that home in its CLI's environment.
// Naming follows MonoCode Native's `Book::find`: exact ID, then ID or label
// ignoring case, spaces and punctuation. An unknown, ambiguous, wrong-harness
// or exhausted account is an error; nothing falls back to another account.
//
// Usage is read on the host and only percentages leave it: Claude from the
// OAuth usage endpoint (the saved access token is read at call time, never
// refreshed, written, cached or logged), Codex from the newest `rate_limits`
// in the account's rollout files.
import { readFileSync, realpathSync, statSync, type Stats } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type {
  HostAccount,
  HostAccountWindow,
} from "../src/features/connections/model/protocol";

export type AccountHarness = "claude" | "codex";
export const ACCOUNT_HARNESSES: readonly AccountHarness[] = ["claude", "codex"];

export type AccountConfig = {
  id: string;
  label: string;
  harness: AccountHarness;
  /** Absolute CLAUDE_CONFIG_DIR or CODEX_HOME. */
  home: string;
};

export type Usage = Omit<HostAccount, "id" | "label" | "harness">;
export type UsageProbe = (account: AccountConfig) => Promise<Usage>;

export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
export const USAGE_TTL_MS = 5 * 60_000;
const ROLLOUT_TAIL_BYTES = 512 * 1024;
const ROLLOUT_FILES_SCANNED = 8;
const ROLLOUT_FILES_LISTED = 5_000;

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function accountsPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.MONOCODE_HOST_ACCOUNTS?.trim();
  return configured
    ? expandHome(configured)
    : join(homedir(), ".monocode-host", "accounts.json");
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/")
    ? join(homedir(), path.slice(1))
    : path;
}

const isDefault = (wanted: string) => /^default$/i.test(wanted.trim());

/** A home must be a directory nobody but its owner can read or enter. */
export function checkHome(account: AccountConfig, info?: Stats): void {
  let stats = info;
  if (!stats) {
    try {
      stats = statSync(account.home);
    } catch {
      throw new Error(
        `Account ${account.id}: home ${account.home} does not exist`,
      );
    }
  }
  if (!stats.isDirectory())
    throw new Error(`Account ${account.id}: home ${account.home} is not a directory`);
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0)
    throw new Error(
      `Account ${account.id}: home ${account.home} has mode ${(stats.mode & 0o777).toString(8)}; it must not be readable by group or others (chmod 700)`,
    );
}

/** Validates a registry document. Homes that exist must be private; two
 * accounts may not share a home (one login would act as both). */
export function parseAccounts(raw: unknown): AccountConfig[] {
  const rows =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as { accounts?: unknown }).accounts
      : raw;
  if (!Array.isArray(rows))
    throw new Error("Account registry must be a JSON array of accounts");
  const accounts: AccountConfig[] = [];
  const ids = new Set<string>();
  const homes = new Map<string, string>();
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== "object" || Array.isArray(row))
      throw new Error(`Account ${index + 1} is not an object`);
    const value = row as Record<string, unknown>;
    const id = value.id;
    if (typeof id !== "string" || !ID.test(id) || isDefault(id))
      throw new Error(
        `Account ${index + 1} needs an id of letters, digits, '.', '_' or '-' (not "default")`,
      );
    if (ids.has(id)) throw new Error(`Duplicate account id ${id}`);
    ids.add(id);
    const label =
      typeof value.label === "string" && value.label.trim()
        ? value.label.trim()
        : id;
    if (label.length > 80 || label.includes("\0"))
      throw new Error(`Account ${id}: label is too long`);
    const harness = value.harness ?? value.kind;
    if (harness !== "claude" && harness !== "codex")
      throw new Error(`Account ${id}: harness must be "claude" or "codex"`);
    if (typeof value.home !== "string" || !value.home.trim())
      throw new Error(`Account ${id}: home is required`);
    const home = resolve(expandHome(value.home.trim()));
    if (!isAbsolute(home))
      throw new Error(`Account ${id}: home must be an absolute path`);
    const account: AccountConfig = { id, label, harness, home };
    let info: Stats | undefined;
    try {
      info = statSync(home);
    } catch {
      info = undefined; // refused when a session tries to use it
    }
    if (info) checkHome(account, info);
    // Compare real paths so a symlink cannot alias another account's home.
    let key = home;
    try {
      key = info ? realpathSync(home) : home;
    } catch {
      /* keep the resolved path */
    }
    const other = homes.get(key);
    if (other)
      throw new Error(
        `Accounts ${other} and ${id} share home ${home}; each account needs its own`,
      );
    homes.set(key, id);
    accounts.push(account);
  }
  return accounts;
}

/** Reads the registry. A missing file means no named accounts. */
export function loadAccounts(path = accountsPath()): AccountConfig[] {
  let text: string;
  try {
    const info = statSync(path);
    if (process.platform !== "win32" && (info.mode & 0o022) !== 0)
      throw new Error(
        `Account registry ${path} is writable by group or others; chmod 600 it`,
      );
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`Account registry ${path} is not valid JSON`);
  }
  return parseAccounts(raw);
}

const nameKey = (value: string) =>
  [...value].filter((c) => /[\p{L}\p{N}]/u.test(c)).join("").toLowerCase();

const isExhausted = (usage: Usage | undefined): boolean =>
  usage?.state === "exhausted";

export class AccountBook {
  private cache = new Map<string, Usage>();
  private inflight: Promise<HostAccount[]> | undefined;

  constructor(
    readonly accounts: readonly AccountConfig[],
    private readonly options: {
      probe?: UsageProbe;
      now?: () => number;
      ttlMs?: number;
    } = {},
  ) {}

  list(harness?: AccountHarness): AccountConfig[] {
    return this.accounts.filter(
      (account) => !harness || account.harness === harness,
    );
  }

  byId(id: string): AccountConfig | undefined {
    return this.accounts.find((account) => account.id === id);
  }

  /** Port of Native `Book::find`. Never substitutes another account. */
  find(harness: string, wanted: string): AccountConfig {
    if (harness !== "claude" && harness !== "codex")
      throw new Error(`${harness} does not support account selection`);
    const rows = this.list(harness);
    const choices = () =>
      rows.map((a) => `"${a.label}" (id ${a.id})`).join(", ") || "none";
    const name = wanted.trim();
    const exact = rows.find((a) => a.id === name);
    if (exact) return exact;
    const target = nameKey(name);
    if (!target)
      throw new Error(`Account name is empty. Choose one of: ${choices()}`);
    let hits = rows.filter(
      (a) => nameKey(a.label) === target || nameKey(a.id) === target,
    );
    // Short id within the harness: "alt" with claude -> claude-alt.
    if (hits.length === 0) {
      const scoped = nameKey(`${harness}-${name}`);
      hits = rows.filter((a) => nameKey(a.id) === scoped);
    }
    if (hits.length === 1) return hits[0];
    if (hits.length > 1)
      throw new Error(
        `Account name "${name}" is ambiguous; use the account id. Choices: ${choices()}`,
      );
    const elsewhere = this.accounts.find(
      (a) =>
        a.id === name || nameKey(a.label) === target || nameKey(a.id) === target,
    );
    if (elsewhere)
      throw new Error(
        `Account "${elsewhere.label}" is a ${elsewhere.harness} account, not ${harness}. Choose one of: ${choices()}`,
      );
    throw new Error(
      `Unknown ${harness} account "${name}". Choose one of: ${choices()}`,
    );
  }

  /** `find`, then refuse an account whose last known usage is at its limit.
   * Returns null for the default login ("default" or nothing named). */
  resolve(harness: string, wanted?: string | null): AccountConfig | null {
    if (wanted == null || isDefault(wanted)) return null;
    const account = this.find(harness, wanted);
    const usage = this.cachedUsage(account.id);
    if (isExhausted(usage))
      throw new Error(
        `Account "${account.label}" is out of usage${usage?.detail ? ` (${usage.detail})` : ""}; choose another account`,
      );
    return account;
  }

  /** Last usage read within the TTL, without probing. */
  cachedUsage(id: string): Usage | undefined {
    const usage = this.cache.get(id);
    if (!usage) return undefined;
    return this.now() - usage.checkedAt < this.ttl() ? usage : undefined;
  }

  /** Every account with its usage; probes those whose reading is stale. */
  async usage(): Promise<HostAccount[]> {
    if (this.inflight) return this.inflight;
    const run = Promise.all(
      this.accounts.map(async (account): Promise<HostAccount> => {
        let usage = this.cachedUsage(account.id);
        if (!usage) {
          try {
            usage = await (this.options.probe ?? probeUsage)(account);
          } catch {
            usage = {
              state: "unknown",
              detail: "Usage could not be read",
              checkedAt: this.now(),
            };
          }
          this.cache.set(account.id, usage);
        }
        return {
          id: account.id,
          label: account.label,
          harness: account.harness,
          ...usage,
        };
      }),
    ).finally(() => {
      if (this.inflight === run) this.inflight = undefined;
    });
    this.inflight = run;
    return run;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private ttl(): number {
    return this.options.ttlMs ?? USAGE_TTL_MS;
  }
}

/** Environment that points a CLI at an account's home. */
export function accountEnv(account: AccountConfig): Record<string, string> {
  return account.harness === "claude"
    ? { CLAUDE_CONFIG_DIR: account.home }
    : { CODEX_HOME: account.home };
}

// The host's registry, reloaded when the file changes.
let loaded:
  | { path: string; signature: string; book?: AccountBook; error?: Error }
  | undefined;
let bookOptions: ConstructorParameters<typeof AccountBook>[1] = {};

function signature(path: string): string {
  try {
    const info = statSync(path);
    return `${info.mtimeMs}:${info.size}:${info.mode}:${info.ino}`;
  } catch {
    return "missing";
  }
}

/** The host's account book. Throws when the registry file is invalid. */
export function hostAccountBook(): AccountBook {
  const path = accountsPath();
  const sig = signature(path);
  if (!loaded || loaded.path !== path || loaded.signature !== sig) {
    try {
      loaded = {
        path,
        signature: sig,
        book: new AccountBook(loadAccounts(path), bookOptions),
      };
    } catch (error) {
      loaded = {
        path,
        signature: sig,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }
  if (loaded.error) throw loaded.error;
  return loaded.book!;
}

/** Tests replace the usage probe and clock; production uses the defaults. */
export function configureHostAccounts(
  options: ConstructorParameters<typeof AccountBook>[1],
): void {
  bookOptions = options;
  loaded = undefined;
}

/**
 * Resolves the account a caller named for a session of `harness`. Returns
 * null for the default login (nothing named, or "default"). Throws for an
 * unknown, ambiguous, wrong-harness or exhausted account.
 */
export function resolveAccount(
  harness: string,
  wanted?: string | null,
): AccountConfig | null {
  if (wanted == null || isDefault(wanted)) return null;
  return hostAccountBook().resolve(harness, wanted);
}

/** Environment for spawning `provider`'s CLI under account `id`. */
export function accountSpawnEnv(
  provider: unknown,
  id: unknown,
): Record<string, string> {
  if (id == null || id === "" || id === "default") return {};
  if (typeof id !== "string") throw new Error("Invalid provider account");
  const account = hostAccountBook().byId(id);
  if (!account) throw new Error(`Unknown provider account "${id}" on this host`);
  if (account.harness !== provider)
    throw new Error(
      `Account "${account.label}" is a ${account.harness} account, not ${String(provider)}`,
    );
  checkHome(account);
  return accountEnv(account);
}

/** Accounts with usage for models.list; `undefined` when none are set up. */
export async function hostAccountUsage(): Promise<{
  accounts?: HostAccount[];
  accountsError?: string;
}> {
  let book: AccountBook;
  try {
    book = hostAccountBook();
  } catch (error) {
    return {
      accountsError: error instanceof Error ? error.message : String(error),
    };
  }
  if (!book.accounts.length) return {};
  return { accounts: await book.usage() };
}

// ---------------------------------------------------------------------------
// Usage probes
// ---------------------------------------------------------------------------

function timestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value))
    return value > 1e12 ? value : value * 1000;
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

/** Combines windows into a state: a window at 100% whose reset has not
 * passed means exhausted. A reset in the past means the window is fresh. */
export function usageState(
  fiveHour: HostAccountWindow | undefined,
  weekly: HostAccountWindow | undefined,
  now: number,
): Usage {
  const fresh = (window?: HostAccountWindow) =>
    window && window.resetsAt !== undefined && window.resetsAt <= now
      ? { usedPercent: 0 }
      : window;
  const five = fresh(fiveHour);
  const week = fresh(weekly);
  const out: Usage = { state: "ok", checkedAt: now };
  if (five) out.fiveHour = five;
  if (week) out.weekly = week;
  if (week && week.usedPercent >= 100) {
    out.state = "exhausted";
    out.detail = "Weekly limit reached";
  } else if (five && five.usedPercent >= 100) {
    out.state = "exhausted";
    out.detail = "5-hour limit reached";
  } else if (!five && !week) {
    out.state = "unknown";
    out.detail = "No usage reported";
  }
  return out;
}

/** Maps the body of GET /api/oauth/usage. */
export function parseClaudeUsage(payload: unknown, now: number): Usage {
  const window = (name: string): HostAccountWindow | undefined => {
    const value =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>)[name]
        : undefined;
    if (!value || typeof value !== "object") return undefined;
    const used = (value as Record<string, unknown>).utilization;
    if (typeof used !== "number" || !Number.isFinite(used)) return undefined;
    const resetsAt = timestamp((value as Record<string, unknown>).resets_at);
    return {
      usedPercent: Math.max(0, used),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    };
  };
  return usageState(window("five_hour"), window("seven_day"), now);
}

type HttpGet = (
  url: string,
  headers: Record<string, string>,
) => Promise<{ status: number; body: unknown }>;

const defaultHttpGet: HttpGet = async (url, headers) => {
  const response = await fetch(url, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
};

export async function probeClaudeUsage(
  account: AccountConfig,
  options: { now?: number; httpGet?: HttpGet } = {},
): Promise<Usage> {
  const now = options.now ?? Date.now();
  let oauth: Record<string, unknown> | undefined;
  try {
    const saved = JSON.parse(
      await readFile(join(account.home, ".credentials.json"), "utf8"),
    ) as Record<string, unknown>;
    const value = saved?.claudeAiOauth;
    oauth =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : undefined;
  } catch {
    oauth = undefined;
  }
  const hasToken =
    typeof oauth?.accessToken === "string" && oauth.accessToken.length > 0;
  if (!hasToken)
    return { state: "disconnected", detail: "Not signed in", checkedAt: now };
  const expiresAt = timestamp(oauth!.expiresAt);
  // The CLI refreshes an expired token on its next run; the host never does.
  const idle: Usage = {
    state: "idle",
    detail: "Refreshes on next use",
    checkedAt: now,
  };
  if (expiresAt !== undefined && expiresAt <= now) return idle;
  let result: { status: number; body: unknown };
  try {
    result = await (options.httpGet ?? defaultHttpGet)(CLAUDE_USAGE_URL, {
      Authorization: `Bearer ${oauth!.accessToken as string}`,
      "anthropic-beta": CLAUDE_OAUTH_BETA,
      "Content-Type": "application/json",
      "User-Agent": "monocode-host",
    });
  } catch {
    // Never include the error: some runtimes echo request headers.
    return { state: "unknown", detail: "Usage service unreachable", checkedAt: now };
  } finally {
    oauth = undefined;
  }
  if (result.status === 401) return idle;
  if (result.status < 200 || result.status >= 300)
    return {
      state: "unknown",
      detail: `Usage service returned HTTP ${result.status}`,
      checkedAt: now,
    };
  return parseClaudeUsage(result.body, now);
}

/** Maps a rollout `rate_limits` object. The shorter window is the 5-hour one. */
export function parseCodexRateLimits(
  limits: unknown,
  observedAt: number,
  now: number,
): Usage {
  const windows: Array<{ minutes?: number; key: string; window: HostAccountWindow }> = [];
  for (const key of ["primary", "secondary"]) {
    const value =
      limits && typeof limits === "object"
        ? (limits as Record<string, unknown>)[key]
        : undefined;
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    const used = row.used_percent;
    if (typeof used !== "number" || !Number.isFinite(used)) continue;
    let resetsAt = timestamp(row.resets_at);
    if (resetsAt === undefined && typeof row.resets_in_seconds === "number")
      resetsAt = observedAt + row.resets_in_seconds * 1000;
    windows.push({
      minutes:
        typeof row.window_minutes === "number" ? row.window_minutes : undefined,
      key,
      window: {
        usedPercent: Math.max(0, used),
        ...(resetsAt !== undefined ? { resetsAt } : {}),
      },
    });
  }
  windows.sort(
    (a, b) =>
      (a.minutes ?? (a.key === "primary" ? 300 : 10_080)) -
      (b.minutes ?? (b.key === "primary" ? 300 : 10_080)),
  );
  return usageState(
    windows[0]?.window,
    windows.length > 1 ? windows.at(-1)!.window : undefined,
    now,
  );
}

function findRateLimits(value: unknown, depth = 0): unknown {
  if (!value || typeof value !== "object" || depth > 4) return undefined;
  const record = value as Record<string, unknown>;
  if (record.rate_limits && typeof record.rate_limits === "object")
    return record.rate_limits;
  for (const key of ["payload", "msg", "info"]) {
    const found = findRateLimits(record[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}

async function tailLines(path: string): Promise<string[]> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - ROLLOUT_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split(/\r?\n/);
    return start > 0 ? lines.slice(1) : lines;
  } finally {
    await handle.close();
  }
}

export async function probeCodexUsage(
  account: AccountConfig,
  options: { now?: number } = {},
): Promise<Usage> {
  const now = options.now ?? Date.now();
  const sessions = join(account.home, "sessions");
  let names: string[];
  try {
    names = (await readdir(sessions, { recursive: true })).filter((name) =>
      /(^|[\\/])rollout-[^\\/]*\.jsonl$/.test(name),
    );
  } catch {
    names = [];
  }
  // Paths embed dates; keep the newest names before statting.
  names.sort().reverse();
  const files = (
    await Promise.all(
      names.slice(0, ROLLOUT_FILES_LISTED).map(async (name) => {
        const path = join(sessions, name);
        try {
          return { path, mtime: (await stat(path)).mtimeMs };
        } catch {
          return undefined;
        }
      }),
    )
  )
    .filter((file): file is { path: string; mtime: number } => !!file)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, ROLLOUT_FILES_SCANNED);
  for (const file of files) {
    let lines: string[];
    try {
      lines = await tailLines(file.path);
    } catch {
      continue;
    }
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index];
      if (!line.includes("rate_limits")) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const limits = findRateLimits(parsed);
      if (!limits) continue;
      const observed =
        timestamp((parsed as Record<string, unknown>).timestamp) ?? file.mtime;
      return parseCodexRateLimits(limits, observed, now);
    }
  }
  return {
    state: "unknown",
    detail: "No usage recorded yet",
    checkedAt: now,
  };
}

export const probeUsage: UsageProbe = (account) =>
  account.harness === "claude"
    ? probeClaudeUsage(account)
    : probeCodexUsage(account);
