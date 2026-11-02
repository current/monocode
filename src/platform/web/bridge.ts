import type { RemoteMachine } from "../../features/connections/model/protocol";

/**
 * The web desk's only transport: a same-origin, owner-authenticated bridge on
 * the embedding site. The browser never holds the host's device token; the
 * bridge adds `version`, `environmentId` and the credential server-side.
 *
 *   POST {base}/rpc   {method, params}  -> the host's JSON ({result} | {error})
 *   GET  {base}/info                    -> {machineId, name, projectPath}
 */
export const BRIDGE_BASE: string =
  (import.meta.env.VITE_DESK_BRIDGE_BASE as string | undefined) ??
  "/api/v1/desk-ai/host";

/** Same cap as the desktop's native HTTP client (src-tauri/src/remote.rs). */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** The methods the desktop forwards, minus credential management: the bridge
 * owns its device token, so the page cannot revoke it. */
const SUPPORTED_METHODS = new Set([
  "environment.describe",
  "projects.list",
  "projects.browse",
  "projects.open",
  "models.list",
  "sessions.list",
  "sessions.update",
  "sessions.delete",
  "sessions.sync",
  "sessions.syncChunk",
  "commands.dispatch",
  "attachments.upload",
  "attachments.read",
  "git.diff",
  "git.branches",
  "git.switch",
  "git.createBranch",
  "git.worktrees",
  "git.worktreeCreate",
  "files.read",
  "files.list",
  "files.index",
  "workspace.run",
  "files.search",
  "files.searchContent",
  "files.create",
  "files.write",
  "git.index",
  "git.fileDiff",
  "git.action",
]);

export type DeskHostInfo = {
  machineId: string;
  name: string;
  projectPath: string;
};

type Fetch = typeof fetch;
let fetchImpl: Fetch | undefined;
/** Tests replace the network; production uses the page's fetch. */
export function setBridgeFetch(next?: Fetch) {
  fetchImpl = next;
  info = undefined;
  machine = undefined;
}
const doFetch: Fetch = (input, init) =>
  (fetchImpl ?? globalThis.fetch.bind(globalThis))(input, init);

const UNREACHABLE =
  "Machine is unreachable. Check the desk host, then reload this page.";

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw "Host response is too large";
  try {
    return JSON.parse(text);
  } catch {
    if (response.status === 401 || response.status === 403)
      throw "Sign in to the desk to use MonoCode.";
    throw response.ok ? "Invalid host response" : `Host returned HTTP ${response.status}`;
  }
}

/**
 * One host call. Rejections are plain strings, as Tauri's `invoke` rejects,
 * with the desktop's wording so existing error handling reads them the same.
 */
export async function bridgeRpc<T = unknown>(
  method: string,
  params: unknown = {},
): Promise<T> {
  if (!SUPPORTED_METHODS.has(method)) throw "Unsupported remote operation";
  let response: Response;
  try {
    response = await doFetch(`${BRIDGE_BASE}/rpc`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, params: params ?? {} }),
    });
  } catch {
    throw UNREACHABLE;
  }
  const value = await readJson(response);
  const record =
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  if (typeof record.error === "string")
    throw `Host rejected request: ${record.error}`;
  if (!response.ok) throw `Host returned HTTP ${response.status}`;
  if (!("result" in record)) throw "Invalid host response";
  if (
    method === "environment.describe" &&
    machine &&
    (record.result as { environmentId?: unknown } | null)?.environmentId !==
      machine.environmentId
  )
    throw "Host identity changed. Reload this page before continuing.";
  return record.result as T;
}

let info: Promise<DeskHostInfo> | undefined;
/** The desk host's identity and the checkout the web desk opens. */
export function deskHostInfo(): Promise<DeskHostInfo> {
  info ??= (async () => {
    let response: Response;
    try {
      response = await doFetch(`${BRIDGE_BASE}/info`, {
        credentials: "same-origin",
      });
    } catch {
      throw UNREACHABLE;
    }
    const value = (await readJson(response)) as Partial<DeskHostInfo> & {
      error?: unknown;
    };
    if (!response.ok)
      throw typeof value?.error === "string"
        ? value.error
        : `Host returned HTTP ${response.status}`;
    if (
      typeof value?.machineId !== "string" ||
      !value.machineId ||
      typeof value.projectPath !== "string" ||
      !value.projectPath
    )
      throw "Invalid desk host info";
    return {
      machineId: value.machineId,
      name: typeof value.name === "string" && value.name ? value.name : "Desk",
      projectPath: value.projectPath,
    };
  })();
  // A failed read is retried on the next call instead of being cached.
  info.catch(() => {
    info = undefined;
  });
  return info;
}

let machine: RemoteMachine | undefined;
let machinePromise: Promise<RemoteMachine> | undefined;
/** The single machine the web desk knows: the bridge's host. */
export function deskMachine(): Promise<RemoteMachine> {
  if (machine) return Promise.resolve(machine);
  machinePromise ??= (async () => {
    const [host, described] = await Promise.all([
      deskHostInfo(),
      bridgeRpc<{ environmentId?: unknown }>("environment.describe", {}),
    ]);
    if (typeof described?.environmentId !== "string")
      throw "Invalid host response";
    machine = {
      id: host.machineId,
      name: host.name,
      endpoint: BRIDGE_BASE,
      environmentId: described.environmentId,
      ssh: null,
    };
    return machine;
  })().finally(() => {
    machinePromise = undefined;
  });
  return machinePromise;
}

/** The cached desk machine, once `deskMachine()` has resolved. */
export function knownDeskMachine(): RemoteMachine | undefined {
  return machine;
}
