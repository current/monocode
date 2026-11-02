import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRIDGE_BASE,
  bridgeRpc,
  deskHostInfo,
  deskMachine,
  setBridgeFetch,
} from "./bridge";

type Call = { url: string; init?: RequestInit };

function fakeBridge(
  routes: Record<string, (body: { method: string; params: unknown }) => Response>,
  info: () => Response = () =>
    Response.json({ machineId: "desk", name: "Desk", projectPath: "/srv/desk" }),
) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === `${BRIDGE_BASE}/info`) return info();
    const body = JSON.parse(String(init?.body));
    const route = routes[body.method];
    return route ? route(body) : Response.json({ error: "Unknown method" }, { status: 400 });
  });
  setBridgeFetch(fetch as unknown as typeof globalThis.fetch);
  return calls;
}

afterEach(() => setBridgeFetch(undefined));

describe("bridgeRpc", () => {
  it("posts {method, params} same-origin without any credential header", async () => {
    const calls = fakeBridge({
      "sessions.list": () => Response.json({ result: [{ id: "s1" }] }),
    });
    await expect(bridgeRpc("sessions.list", { projectId: "p1" })).resolves.toEqual([
      { id: "s1" },
    ]);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe("/api/v1/desk-ai/host/rpc");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("same-origin");
    const headers = new Headers(init?.headers);
    expect(headers.has("authorization")).toBe(false);
    // The bridge adds version, environmentId and the token server-side.
    expect(JSON.parse(String(init?.body))).toEqual({
      method: "sessions.list",
      params: { projectId: "p1" },
    });
  });

  it("rejects with the host's error as the desktop words it", async () => {
    fakeBridge({
      "sessions.sync": () =>
        Response.json({ error: "Session not found" }, { status: 400 }),
    });
    await expect(bridgeRpc("sessions.sync", {})).rejects.toBe(
      "Host rejected request: Session not found",
    );
  });

  it("reports a signed-out bridge and non-JSON failures", async () => {
    fakeBridge({
      "projects.list": () => new Response("<html>login</html>", { status: 401 }),
      "models.list": () => new Response("bad gateway", { status: 502 }),
    });
    await expect(bridgeRpc("projects.list")).rejects.toBe(
      "Sign in to the desk to use MonoCode.",
    );
    await expect(bridgeRpc("models.list")).rejects.toBe("Host returned HTTP 502");
  });

  it("reports an unreachable bridge", async () => {
    setBridgeFetch((async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch);
    await expect(bridgeRpc("projects.list")).rejects.toMatch(/unreachable/);
  });

  it("never forwards methods outside the desktop's list or credential changes", async () => {
    const calls = fakeBridge({});
    await expect(bridgeRpc("devices.revokeSelf")).rejects.toBe(
      "Unsupported remote operation",
    );
    await expect(bridgeRpc("shell.exec")).rejects.toBe("Unsupported remote operation");
    expect(calls).toHaveLength(0);
  });
});

describe("desk host", () => {
  it("reads the host info once and validates it", async () => {
    const calls = fakeBridge({});
    await expect(deskHostInfo()).resolves.toEqual({
      machineId: "desk",
      name: "Desk",
      projectPath: "/srv/desk",
    });
    await deskHostInfo();
    expect(calls.filter((call) => call.url.endsWith("/info"))).toHaveLength(1);
    expect(calls[0].init?.credentials).toBe("same-origin");

    fakeBridge({}, () => Response.json({ machineId: "desk" }));
    await expect(deskHostInfo()).rejects.toBe("Invalid desk host info");
  });

  it("retries a failed info read on the next call", async () => {
    let ok = false;
    fakeBridge({}, () =>
      ok
        ? Response.json({ machineId: "desk", name: "Desk", projectPath: "/srv" })
        : Response.json({ error: "Owner session expired" }, { status: 401 }),
    );
    await expect(deskHostInfo()).rejects.toBe("Owner session expired");
    ok = true;
    await expect(deskHostInfo()).resolves.toMatchObject({ projectPath: "/srv" });
  });

  it("is the one machine, identified by the host's environment", async () => {
    fakeBridge({
      "environment.describe": () =>
        Response.json({ result: { environmentId: "env-1", providers: ["claude"] } }),
    });
    await expect(deskMachine()).resolves.toEqual({
      id: "desk",
      name: "Desk",
      endpoint: BRIDGE_BASE,
      environmentId: "env-1",
      ssh: null,
    });
  });

  it("refuses a host whose identity changed after connecting", async () => {
    let environmentId = "env-1";
    fakeBridge({
      "environment.describe": () => Response.json({ result: { environmentId } }),
    });
    await deskMachine();
    environmentId = "env-2";
    await expect(bridgeRpc("environment.describe")).rejects.toMatch(
      /identity changed/,
    );
  });
});
