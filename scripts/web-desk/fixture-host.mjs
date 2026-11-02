// Starts an isolated MonoCode host for the web desk (tests and `dev:web`).
// The host runs with a temporary HOME, data directory and PATH holding only
// Node and a fake `claude` (tests/web-desk/fake-claude.cjs), so it never
// finds or runs a real provider. It is paired once and its token handed to
// the development bridge.
//
//   node scripts/web-desk/fixture-host.mjs   # prints MONOCODE_DESK_* exports
import { spawn, execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const hostEntry = join(root, "build", "host", "monocode-host.mjs");

/** Every provider launcher name in host/process.ts except Claude's. */
const STUBBED_PROVIDER_BINARIES = [
  "codex",
  "cursor-agent",
  "agent",
  "grok",
  "opencode",
  "pi-coding-agent",
  "omp",
  "fx",
  "hermes",
  "agy_acp_server.par",
  "devin",
];

export async function startFixtureHost({ port = 3790 } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "monocode-web-desk-")));
  try {
    return await startIn(base, port);
  } catch (error) {
    rmSync(base, { recursive: true, force: true });
    throw error;
  }
}

async function startIn(base, port) {
  const home = join(base, "home");
  const bin = join(base, "bin");
  const data = join(base, "data");
  const project = join(base, "desk-project");
  for (const dir of [home, bin, project]) mkdirSync(dir, { recursive: true });
  symlinkSync(process.execPath, join(bin, "node"));
  // Git and a shell for the host's Git views; nothing else from the real PATH.
  for (const tool of ["git", "sh"]) {
    try {
      const found = execFileSync("/usr/bin/which", [tool], { encoding: "utf8" }).trim();
      if (found) symlinkSync(found, join(bin, tool));
    } catch {
      /* optional */
    }
  }
  copyFileSync(join(root, "tests", "web-desk", "fake-claude.cjs"), join(bin, "claude"));
  chmodSync(join(bin, "claude"), 0o755);
  // The host also searches standard install folders outside PATH. A failing
  // stub earlier in PATH shadows every other provider, so the fixture never
  // starts a real CLI. (`fx_model` satisfies the host's fx launcher check.)
  for (const name of STUBBED_PROVIDER_BINARIES) {
    writeFileSync(
      join(bin, name),
      `#!/bin/sh\n# fx_model\necho "${name} is disabled in the web desk fixture" >&2\nexit 1\n`,
      { mode: 0o755 },
    );
  }
  writeFileSync(join(project, "README.md"), "# Desk fixture project\n");
  mkdirSync(join(project, "src"));
  writeFileSync(join(project, "src", "index.ts"), "export const desk = true;\n");
  const env = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    PATH: bin,
    LANG: "en_US.UTF-8",
    TMPDIR: tmpdir(),
  };
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: project,
      env: { ...env, PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null" },
      stdio: "ignore",
    });
  try {
    git("init", "-q", "-b", "main");
    git("-c", "user.name=Desk", "-c", "user.email=desk@example.invalid", "add", ".");
    git("-c", "user.name=Desk", "-c", "user.email=desk@example.invalid", "commit", "-qm", "fixture");
  } catch {
    /* a plain folder is still a valid desk project */
  }
  const paired = JSON.parse(
    execFileSync(process.execPath, [hostEntry, "pair", "--name", "web-desk", "--json", "--data-dir", data], {
      env,
      encoding: "utf8",
    }),
  );
  const child = spawn(process.execPath, [hostEntry, "serve", "--data-dir", data, "--port", String(port)], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (chunk) => (log += chunk));
  child.stderr.on("data", (chunk) => (log += chunk));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`Fixture host exited:\n${log}`);
    try {
      const response = await fetch(`${url}/rpc`, {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ version: 1, method: "environment.describe", params: {} }),
      });
      if (response.ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`Fixture host did not start:\n${log}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return {
    url,
    token: paired.token,
    projectPath: project,
    log: () => log,
    async stop() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
          }, 5_000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      rmSync(base, { recursive: true, force: true });
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const host = await startFixtureHost({ port: Number(process.env.PORT ?? 3790) });
  console.log(`export MONOCODE_DESK_HOST_URL=${host.url}`);
  console.log(`export MONOCODE_DESK_TOKEN=${host.token}`);
  console.log(`export MONOCODE_DESK_PROJECT=${host.projectPath}`);
  console.error("Fixture host running; Ctrl-C stops it and deletes its data.");
  const stop = () => void host.stop().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
