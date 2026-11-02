import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { hostWorktrees, type HostWorktree } from "./git-worktrees";

const exec = promisify(execFile);
const git = (cwd: string, args: string[]) =>
  exec("git", args, { cwd, timeout: 30_000, maxBuffer: 1024 * 1024 });

/** A job name is one path segment: no separators, no dot segments. */
const JOB = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

/**
 * Where an operator's per-worker worktrees live: `MONOCODE_HOST_WORKTREE_ROOT`
 * when set, otherwise `<workspace>-worktrees` beside the workspace (for
 * `~/trade` that is `~/trade-worktrees`, the same folder the Git views use).
 */
export function worktreeRoot(
  workspace: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.MONOCODE_HOST_WORKTREE_ROOT?.trim();
  if (configured) {
    if (!isAbsolute(configured) || configured.includes("\0"))
      throw new Error("MONOCODE_HOST_WORKTREE_ROOT must be an absolute path");
    return resolve(configured);
  }
  return join(dirname(workspace), `${basename(workspace)}-worktrees`);
}

/** The worktree path for a job, refusing anything that leaves the root. */
export function jobWorktreePath(root: string, job: unknown): string {
  if (
    typeof job !== "string" ||
    !JOB.test(job) ||
    job.includes("..") ||
    job.includes("/") ||
    job.includes("\\")
  )
    throw new Error(
      "Provide job: one folder name (letters, digits, '.', '_' or '-'; no '/' or '..')",
    );
  const path = resolve(root, job);
  const inside = relative(resolve(root), path);
  if (!inside || inside.startsWith("..") || isAbsolute(inside) || inside.includes(sep))
    throw new Error("Worktree path is outside the worktree root");
  return path;
}

function refText(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 255 ||
    value.startsWith("-") ||
    /[\0\s]/.test(value)
  )
    throw new Error(`Invalid ${label}`);
  return value;
}

/**
 * `git worktree add -b <branch> <root>/<job> <base>` for one worker.
 * The branch defaults to the job name; the base must resolve to a commit.
 */
export async function createJobWorktree(input: {
  workspace: string;
  job: unknown;
  base?: unknown;
  branch?: unknown;
  env?: NodeJS.ProcessEnv;
}): Promise<HostWorktree> {
  const root = worktreeRoot(input.workspace, input.env);
  const path = jobWorktreePath(root, input.job);
  const base = refText(input.base ?? "HEAD", "base ref");
  const branch = refText(input.branch ?? input.job, "branch name");
  if (branch.startsWith("@")) throw new Error("Invalid branch name");
  await git(input.workspace, ["check-ref-format", "--branch", branch]).catch(() => {
    throw new Error("Invalid branch name");
  });
  if (existsSync(path)) throw new Error(`${path} already exists`);
  const listed = await hostWorktrees(input.workspace);
  if (listed.worktrees.some((tree) => tree.branch === branch))
    throw new Error(`Branch ${branch} already has a worktree`);
  const commit = (
    await git(input.workspace, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${base}^{commit}`,
    ]).catch(() => {
      throw new Error(`Base ref ${base} is not a commit in this repository`);
    })
  ).stdout.trim();
  await mkdir(root, { recursive: true });
  // The root may itself be a link; the created folder must still be inside it.
  jobWorktreePath(realpathSync.native(root), input.job);
  await git(input.workspace, [
    "worktree",
    "add",
    "--no-track",
    "-b",
    branch,
    "--",
    path,
    commit,
  ]);
  const real = realpathSync.native(path);
  const created = (await hostWorktrees(input.workspace)).worktrees.find(
    (tree) => tree.path === real,
  );
  if (!created) throw new Error("Worktree created, but git does not list it");
  return created;
}
