// Development stand-in for the trading site's desk bridge
// (POST /api/v1/desk-ai/host/rpc, GET /api/v1/desk-ai/host/info).
// It forwards to a MonoCode host on loopback and adds the protocol version,
// the host's environment ID and the device token server-side, so the
// browser never sees the token. Production uses the site's own bridge.
import { request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";

export const BRIDGE_PREFIX = "/api/v1/desk-ai/host";
const MAX_BODY = 32 * 1024 * 1024;

/** Reads the bridge settings from the environment. */
export function bridgeOptionsFromEnv(env = process.env) {
  const tokenFile = env.MONOCODE_DESK_TOKEN_FILE;
  const token = (
    env.MONOCODE_DESK_TOKEN ??
    (tokenFile ? readFileSync(tokenFile, "utf8") : "")
  ).trim();
  return {
    hostUrl: env.MONOCODE_DESK_HOST_URL ?? "http://127.0.0.1:3774",
    token,
    projectPath: env.MONOCODE_DESK_PROJECT ?? process.cwd(),
    machineId: env.MONOCODE_DESK_MACHINE_ID ?? "desk",
    name: env.MONOCODE_DESK_NAME ?? "Desk",
  };
}

function hostCall(hostUrl, token, payload) {
  const url = new URL("/rpc", hostUrl);
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    // node:http sends no Origin header; the host rejects browser origins.
    const req = httpRequest(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 30_000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 502, body: Buffer.concat(chunks) }),
        );
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("Host request timed out")));
    req.on("error", reject);
    req.end(body);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("Request body is too large"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const send = (res, status, value) => {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Content-Length": body.length,
  });
  res.end(body);
};

/**
 * A Connect-style middleware: `(req, res, next)`. Requests outside the bridge
 * prefix go to `next`.
 */
export function createDeskBridge(options) {
  const { hostUrl, token, projectPath, machineId, name } = options;
  let environmentId;
  const environment = async () => {
    if (environmentId) return environmentId;
    const { status, body } = await hostCall(hostUrl, token, {
      version: 1,
      method: "environment.describe",
      params: {},
    });
    const value = JSON.parse(body.toString("utf8"));
    if (status !== 200 || typeof value?.result?.environmentId !== "string")
      throw new Error(value?.error ?? `Host returned HTTP ${status}`);
    environmentId = value.result.environmentId;
    return environmentId;
  };
  return async (req, res, next) => {
    const path = (req.url ?? "").split("?")[0];
    if (!path.startsWith(BRIDGE_PREFIX)) return next?.();
    const route = path.slice(BRIDGE_PREFIX.length);
    try {
      if (!token)
        return send(res, 503, {
          error:
            "Desk bridge has no device token. Set MONOCODE_DESK_TOKEN (from `monocode-host pair`).",
        });
      if (route === "/info" && req.method === "GET")
        return send(res, 200, { machineId, name, projectPath });
      if (route !== "/rpc" || req.method !== "POST")
        return send(res, 404, { error: "Not found" });
      let input;
      try {
        input = JSON.parse(await readBody(req));
      } catch {
        return send(res, 400, { error: "Invalid request" });
      }
      if (!input || typeof input.method !== "string")
        return send(res, 400, { error: "Invalid request" });
      const { status, body } = await hostCall(hostUrl, token, {
        version: 1,
        environmentId: await environment(),
        method: input.method,
        params: input.params ?? {},
      });
      return send(res, status, body);
    } catch (error) {
      return send(res, 502, {
        error: `Desk host is unreachable: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };
}
