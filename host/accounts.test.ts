import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AccountBook,
  CLAUDE_OAUTH_BETA,
  CLAUDE_USAGE_URL,
  accountSpawnEnv,
  configureHostAccounts,
  hostAccountUsage,
  loadAccounts,
  parseAccounts,
  parseClaudeUsage,
  probeClaudeUsage,
  probeCodexUsage,
  resolveAccount,
  type AccountConfig,
  type Usage,
} from "./accounts";

const FIXTURES = fileURLToPath(new URL("./fixtures/accounts", import.meta.url));
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.unstubAllEnvs();
  configureHostAccounts({});
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "monocode-accounts-test-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function home(root: string, name: string, mode = 0o700): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  chmodSync(path, mode);
  return path;
}

const unix = process.platform !== "win32";

describe("registry validation", () => {
  it("accepts private homes and the {accounts: [...]} form", () => {
    const root = scratch();
    const accounts = parseAccounts({
      accounts: [
        { id: "claude-main", label: "Claude (main)", harness: "claude", home: home(root, "a") },
        { id: "codex-alt", harness: "codex", home: home(root, "b") },
      ],
    });
    expect(accounts.map((a) => [a.id, a.label, a.harness])).toEqual([
      ["claude-main", "Claude (main)", "claude"],
      ["codex-alt", "codex-alt", "codex"],
    ]);
  });

  it.runIf(unix)("refuses a home readable by group or others", () => {
    const root = scratch();
    expect(() =>
      parseAccounts([
        { id: "a", harness: "claude", home: home(root, "open", 0o750) },
      ]),
    ).toThrow(/must not be readable by group or others/);
    expect(() =>
      parseAccounts([
        { id: "a", harness: "claude", home: home(root, "world", 0o704) },
      ]),
    ).toThrow(/chmod 700/);
  });

  it("refuses two accounts sharing a home, also through a symlink", () => {
    const root = scratch();
    const shared = home(root, "shared");
    expect(() =>
      parseAccounts([
        { id: "a", harness: "claude", home: shared },
        { id: "b", harness: "codex", home: `${shared}/` },
      ]),
    ).toThrow(/share home/);
    symlinkSync(shared, join(root, "alias"));
    expect(() =>
      parseAccounts([
        { id: "a", harness: "claude", home: shared },
        { id: "b", harness: "claude", home: join(root, "alias") },
      ]),
    ).toThrow(/share home/);
  });

  it("refuses bad ids, duplicates, unknown harnesses and missing homes", () => {
    const root = scratch();
    const h = home(root, "h");
    expect(() => parseAccounts([{ id: "default", harness: "claude", home: h }])).toThrow(/id/);
    expect(() => parseAccounts([{ id: "../x", harness: "claude", home: h }])).toThrow(/id/);
    expect(() =>
      parseAccounts([
        { id: "a", harness: "claude", home: h },
        { id: "a", harness: "claude", home: home(root, "h2") },
      ]),
    ).toThrow(/Duplicate/);
    expect(() => parseAccounts([{ id: "a", harness: "gemini", home: h }])).toThrow(/harness/);
    expect(() => parseAccounts([{ id: "a", harness: "claude" }])).toThrow(/home/);
    expect(() => parseAccounts("nope")).toThrow(/array/);
  });

  it("treats a missing registry as no accounts and rejects invalid JSON", () => {
    const root = scratch();
    expect(loadAccounts(join(root, "missing.json"))).toEqual([]);
    const file = join(root, "bad.json");
    writeFileSync(file, "{", { mode: 0o600 });
    expect(() => loadAccounts(file)).toThrow(/not valid JSON/);
  });

  it.runIf(unix)("refuses a registry file others can write", () => {
    const root = scratch();
    const file = join(root, "accounts.json");
    writeFileSync(file, "[]");
    chmodSync(file, 0o666);
    expect(() => loadAccounts(file)).toThrow(/writable by group or others/);
  });
});

describe("find (port of Native Book::find)", () => {
  const accounts: AccountConfig[] = [
    { id: "claude-main", label: "Claude (main)", harness: "claude", home: "/h/1" },
    { id: "claude-alt-3", label: "Claude (alt-3)", harness: "claude", home: "/h/2" },
    { id: "codex-main", label: "Codex (main)", harness: "codex", home: "/h/3" },
  ];
  const book = new AccountBook(accounts);

  it("matches the exact id, then id or label ignoring case and punctuation", () => {
    expect(book.find("claude", "claude-alt-3").id).toBe("claude-alt-3");
    expect(book.find("claude", "Claude (alt-3)").id).toBe("claude-alt-3");
    expect(book.find("claude", "claude ALT 3").id).toBe("claude-alt-3");
    expect(book.find("claude", "  claude main ").id).toBe("claude-main");
    // Short id within the harness, as the server's accounts file names them.
    expect(book.find("claude", "main").id).toBe("claude-main");
    expect(book.find("claude", "alt-3").id).toBe("claude-alt-3");
    expect(book.find("claude", "alt3").id).toBe("claude-alt-3");
    expect(book.find("codex", "main").id).toBe("codex-main");
    expect(() => book.find("codex", "alt-3")).toThrow(/Unknown codex account/);
  });

  it("errors for unknown, wrong-harness, empty and ambiguous names", () => {
    expect(() => book.find("claude", "alt-9")).toThrow(
      /Unknown claude account "alt-9"\. Choose one of: "Claude \(main\)"/,
    );
    expect(() => book.find("claude", "Codex (main)")).toThrow(
      /is a codex account, not claude/,
    );
    expect(() => book.find("claude", "!!")).toThrow(/empty/);
    expect(() => book.find("cursor", "x")).toThrow(/does not support account selection/);
    const twins = new AccountBook([
      { id: "a1", label: "Alt", harness: "claude", home: "/x/1" },
      { id: "a2", label: "alt", harness: "claude", home: "/x/2" },
    ]);
    expect(() => twins.find("claude", "ALT")).toThrow(/ambiguous/);
  });

  it("resolves default to no account and refuses exhausted accounts", async () => {
    const probe = vi.fn(
      async (account: AccountConfig): Promise<Usage> =>
        account.id === "claude-main"
          ? { state: "exhausted", detail: "Weekly limit reached", checkedAt: 0 }
          : { state: "ok", fiveHour: { usedPercent: 10 }, checkedAt: 0 },
    );
    const limited = new AccountBook(accounts, { probe, now: () => 1 });
    expect(limited.resolve("claude", undefined)).toBeNull();
    expect(limited.resolve("claude", "default")).toBeNull();
    // Before usage is known, nothing is refused for being exhausted.
    expect(limited.resolve("claude", "claude-main")?.id).toBe("claude-main");
    await limited.usage();
    expect(() => limited.resolve("claude", "Claude (main)")).toThrow(
      /out of usage \(Weekly limit reached\)/,
    );
    expect(limited.resolve("claude", "claude-alt-3")?.id).toBe("claude-alt-3");
  });

  it("caches usage for five minutes", async () => {
    let now = 1_000;
    const probe = vi.fn(async (): Promise<Usage> => ({ state: "ok", checkedAt: now }));
    const cached = new AccountBook(accounts.slice(0, 1), { probe, now: () => now });
    await cached.usage();
    now += 4 * 60_000;
    await cached.usage();
    expect(probe).toHaveBeenCalledTimes(1);
    now += 2 * 60_000;
    await cached.usage();
    expect(probe).toHaveBeenCalledTimes(2);
  });
});

describe("host registry and spawn environment", () => {
  function registry() {
    const root = scratch();
    const claude = home(root, "claude-alt");
    const codex = home(root, "codex-alt");
    const file = join(root, "accounts.json");
    writeFileSync(
      file,
      JSON.stringify([
        { id: "claude-alt", label: "Claude (alt)", harness: "claude", home: claude },
        { id: "codex-alt", label: "Codex (alt)", harness: "codex", home: codex },
      ]),
      { mode: 0o600 },
    );
    vi.stubEnv("MONOCODE_HOST_ACCOUNTS", file);
    return { root, claude, codex, file };
  }

  it("injects the account's config dir and nothing else", () => {
    const { claude, codex } = registry();
    expect(accountSpawnEnv("claude", "claude-alt")).toEqual({ CLAUDE_CONFIG_DIR: claude });
    expect(accountSpawnEnv("codex", "codex-alt")).toEqual({ CODEX_HOME: codex });
    expect(accountSpawnEnv("claude", "default")).toEqual({});
    expect(accountSpawnEnv("claude", undefined)).toEqual({});
  });

  it("adds a setup-token login to the spawn env when the home has one", () => {
    const { claude } = registry();
    writeFileSync(join(claude, ".oauth-token"), "sk-ant-oat01-test\n", { mode: 0o600 });
    expect(accountSpawnEnv("claude", "claude-alt")).toEqual({
      CLAUDE_CONFIG_DIR: claude,
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test",
    });
  });

  it("reports a token account's usage from the pushed snapshot, else unknown but usable", async () => {
    const { claude } = registry();
    writeFileSync(join(claude, ".oauth-token"), "sk-ant-oat01-test", { mode: 0o600 });
    const account = { id: "claude-alt", label: "Claude (alt)", harness: "claude" as const, home: claude };
    const now = Date.parse("2026-11-02T20:00:00Z");
    const httpGet = vi.fn();
    expect((await probeClaudeUsage(account, { now, httpGet })).state).toBe("unknown");
    writeFileSync(
      join(claude, "usage.json"),
      JSON.stringify({
        fetchedAt: now - 60_000,
        usage: { five_hour: { utilization: 42, resets_at: "2026-11-02T22:00:00Z" }, seven_day: { utilization: 10 } },
      }),
    );
    const usage = await probeClaudeUsage(account, { now, httpGet });
    expect(usage.state).toBe("ok");
    expect(usage.fiveHour?.usedPercent).toBe(42);
    writeFileSync(join(claude, "usage.json"), JSON.stringify({ fetchedAt: now - 3_600_000, usage: {} }));
    expect((await probeClaudeUsage(account, { now, httpGet })).state).toBe("unknown");
    expect(httpGet).not.toHaveBeenCalled();
  });

  it("refuses unknown and wrong-harness accounts at spawn", () => {
    registry();
    expect(() => accountSpawnEnv("claude", "nope")).toThrow(/Unknown provider account/);
    expect(() => accountSpawnEnv("codex", "claude-alt")).toThrow(/not codex/);
  });

  it.runIf(unix)("refuses a home whose permissions were loosened after loading", () => {
    const { claude } = registry();
    expect(accountSpawnEnv("claude", "claude-alt")).toBeTruthy();
    chmodSync(claude, 0o755);
    expect(() => accountSpawnEnv("claude", "claude-alt")).toThrow(/chmod 700/);
  });

  it("resolveAccount uses the file and reloads it when it changes", () => {
    const { root, file } = registry();
    expect(resolveAccount("claude", "Claude (alt)")?.id).toBe("claude-alt");
    expect(resolveAccount("claude", "alt")?.id).toBe("claude-alt");
    expect(resolveAccount("codex", "alt")?.id).toBe("codex-alt");
    expect(resolveAccount("claude", null)).toBeNull();
    writeFileSync(
      file,
      JSON.stringify([{ id: "claude-new", harness: "claude", home: home(root, "new") }]),
      { mode: 0o600 },
    );
    utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    expect(() => resolveAccount("claude", "claude-alt")).toThrow(/Unknown claude account/);
    expect(resolveAccount("claude", "claude new")?.id).toBe("claude-new");
  });

  it("reports accounts with usage, or the registry error, for models.list", async () => {
    registry();
    configureHostAccounts({
      probe: async () => ({ state: "ok", fiveHour: { usedPercent: 25 }, checkedAt: 7 }),
    });
    const listed = await hostAccountUsage();
    expect(listed.accounts).toEqual([
      { id: "claude-alt", label: "Claude (alt)", harness: "claude", state: "ok", fiveHour: { usedPercent: 25 }, checkedAt: 7 },
      { id: "codex-alt", label: "Codex (alt)", harness: "codex", state: "ok", fiveHour: { usedPercent: 25 }, checkedAt: 7 },
    ]);
    // No serialized field may carry a home path or credential.
    expect(JSON.stringify(listed)).not.toMatch(/home|token|credential/i);
    vi.stubEnv("MONOCODE_HOST_ACCOUNTS", join(scratch(), "missing.json"));
    expect(await hostAccountUsage()).toEqual({});
  });
});

describe("Claude usage", () => {
  const recorded = JSON.parse(readFileSync(join(FIXTURES, "claude-usage.json"), "utf8"));
  const now = Date.parse("2026-11-02T12:00:00Z");

  function claudeHome(credentials?: object): AccountConfig {
    const root = scratch();
    const path = home(root, "claude");
    if (credentials)
      writeFileSync(join(path, ".credentials.json"), JSON.stringify(credentials), { mode: 0o600 });
    return { id: "c", label: "C", harness: "claude", home: path };
  }

  it("parses the recorded usage body", () => {
    expect(parseClaudeUsage(recorded, now)).toEqual({
      state: "exhausted",
      detail: "Weekly limit reached",
      fiveHour: { usedPercent: 42, resetsAt: Date.parse("2026-11-02T15:00:00Z") },
      weekly: { usedPercent: 100, resetsAt: Date.parse("2026-11-05T09:00:00Z") },
      checkedAt: now,
    });
    // After the weekly reset the window counts as fresh.
    const later = Date.parse("2026-11-06T00:00:00Z");
    expect(parseClaudeUsage(recorded, later)).toMatchObject({
      state: "ok",
      weekly: { usedPercent: 0 },
    });
  });

  it("calls the usage endpoint with the saved bearer token, read-only", async () => {
    const account = claudeHome({
      claudeAiOauth: { accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresAt: now + 3_600_000 },
    });
    const before = readFileSync(join(account.home, ".credentials.json"), "utf8");
    const httpGet = vi.fn(async () => ({ status: 200, body: recorded }));
    const usage = await probeClaudeUsage(account, { now, httpGet });
    expect(usage.state).toBe("exhausted");
    expect(httpGet).toHaveBeenCalledWith(
      CLAUDE_USAGE_URL,
      expect.objectContaining({
        Authorization: "Bearer fixture-access",
        "anthropic-beta": CLAUDE_OAUTH_BETA,
      }),
    );
    expect(JSON.stringify(usage)).not.toContain("fixture-");
    expect(readFileSync(join(account.home, ".credentials.json"), "utf8")).toBe(before);
  });

  it("reports an expired or rejected token as idle, not disconnected", async () => {
    const expired = claudeHome({ claudeAiOauth: { accessToken: "t", expiresAt: now - 1 } });
    const httpGet = vi.fn(async () => ({ status: 200, body: recorded }));
    expect(await probeClaudeUsage(expired, { now, httpGet })).toEqual({
      state: "idle",
      detail: "Refreshes on next use",
      checkedAt: now,
    });
    expect(httpGet).not.toHaveBeenCalled();
    const rejected = claudeHome({ claudeAiOauth: { accessToken: "t", expiresAt: now + 60_000 } });
    expect(
      (await probeClaudeUsage(rejected, { now, httpGet: async () => ({ status: 401, body: {} }) })).state,
    ).toBe("idle");
  });

  it("reports no login as disconnected and failures without details", async () => {
    expect((await probeClaudeUsage(claudeHome(), { now })).state).toBe("disconnected");
    const account = claudeHome({ claudeAiOauth: { accessToken: "secret-value", expiresAt: now + 60_000 } });
    const failed = await probeClaudeUsage(account, {
      now,
      httpGet: async () => {
        throw new Error("Bearer secret-value refused");
      },
    });
    expect(failed).toEqual({ state: "unknown", detail: "Usage service unreachable", checkedAt: now });
    expect(
      (await probeClaudeUsage(account, { now, httpGet: async () => ({ status: 503, body: null }) })).detail,
    ).toBe("Usage service returned HTTP 503");
  });
});

describe("Codex usage", () => {
  function codexHome(): AccountConfig {
    const root = scratch();
    const path = home(root, "codex");
    return { id: "x", label: "X", harness: "codex", home: path };
  }

  it("reads the newest rate_limits from the recorded rollout", async () => {
    const account = codexHome();
    const day = join(account.home, "sessions", "2026", "11", "02");
    mkdirSync(day, { recursive: true });
    copyFileSync(join(FIXTURES, "codex-rollout.jsonl"), join(day, "rollout-2026-11-02T09-00-00-fixture.jsonl"));
    const now = Date.parse("2026-11-02T10:00:00Z");
    expect(await probeCodexUsage(account, { now })).toEqual({
      state: "exhausted",
      detail: "5-hour limit reached",
      fiveHour: { usedPercent: 100, resetsAt: 1793628470_000 },
      weekly: { usedPercent: 31, resetsAt: 1794173530_000 },
      checkedAt: now,
    });
    // A window whose reset time passed counts as fresh.
    const later = 1793628470_000 + 1;
    expect(await probeCodexUsage(account, { now: later })).toMatchObject({
      state: "ok",
      fiveHour: { usedPercent: 0 },
      weekly: { usedPercent: 31 },
    });
  });

  it("prefers the most recently modified rollout", async () => {
    const account = codexHome();
    const day = join(account.home, "sessions", "2026", "11", "01");
    mkdirSync(day, { recursive: true });
    const older = join(day, "rollout-2026-11-01T00-00-00-a.jsonl");
    const newer = join(day, "rollout-2026-10-01T00-00-00-b.jsonl");
    const line = (used: number) =>
      JSON.stringify({ timestamp: "2026-11-01T00:00:00Z", type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: used, window_minutes: 300, resets_in_seconds: 3600 } } } });
    writeFileSync(older, `${line(5)}\n`);
    writeFileSync(newer, `${line(55)}\n`);
    utimesSync(older, new Date(1_000), new Date(1_000));
    const usage = await probeCodexUsage(account, { now: Date.parse("2026-11-01T00:10:00Z") });
    expect(usage.fiveHour).toEqual({ usedPercent: 55, resetsAt: Date.parse("2026-11-01T01:00:00Z") });
  });

  it("reports unknown when no rollout has rate limits", async () => {
    expect((await probeCodexUsage(codexHome(), { now: 1 })).state).toBe("unknown");
  });
});
