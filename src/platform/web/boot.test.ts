// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BRIDGE_BASE, setBridgeFetch } from "./bridge";
import { applyWebDeskChrome, prepareWebDesk, renderWebDeskError } from "./boot";
import { lastProjectPath, loadRecents } from "../../features/projects/model/recents";
import { remoteProjectFor } from "../../features/connections/model/remoteProjects";

const opened: unknown[] = [];

beforeEach(() => {
  localStorage.clear();
  opened.length = 0;
  setBridgeFetch((async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === `${BRIDGE_BASE}/info`)
      return Response.json({
        machineId: "desk",
        name: "Desk",
        projectPath: "/home/trader/desk",
      });
    const body = JSON.parse(String(init?.body));
    if (body.method === "environment.describe")
      return Response.json({ result: { environmentId: "env-1" } });
    if (body.method === "projects.open") {
      opened.push(body.params);
      return Response.json({
        result: { id: "proj-1", cwd: "/home/trader/desk", name: "desk" },
      });
    }
    return Response.json({ error: "unexpected" }, { status: 400 });
  }) as unknown as typeof fetch);
});

afterEach(() => {
  setBridgeFetch(undefined);
  document.documentElement.className = "";
});

describe("web desk boot", () => {
  it("opens the host checkout and makes it the only project", async () => {
    localStorage.setItem(
      "monocode.recentProjects",
      JSON.stringify([{ path: "/Users/me/other", openedAt: 1 }]),
    );
    const boot = await prepareWebDesk();
    expect(opened).toEqual([{ cwd: "/home/trader/desk" }]);
    expect(boot.projectKey).toBe("remote://env-1/home/trader/desk");
    expect(boot.machine).toMatchObject({ id: "desk", environmentId: "env-1" });
    expect(loadRecents().map((item) => item.path)).toEqual([boot.projectKey]);
    expect(lastProjectPath()).toBe(boot.projectKey);
    expect(remoteProjectFor(boot.projectKey)).toEqual({
      key: boot.projectKey,
      environmentId: "env-1",
      projectId: "proj-1",
      cwd: "/home/trader/desk",
    });
    expect(document.documentElement.classList.contains("web-desk")).toBe(true);
  });

  it("fails without touching saved projects when the bridge refuses", async () => {
    setBridgeFetch((async () =>
      Response.json({ error: "Owner session expired" }, { status: 401 })) as unknown as typeof fetch);
    localStorage.setItem("monocode.recentProjects", "[]");
    await expect(prepareWebDesk()).rejects.toBeTruthy();
    expect(localStorage.getItem("monocode.recentProjects")).toBe("[]");
  });

  it("drops desktop window chrome classes", () => {
    const root = document.documentElement;
    root.classList.add("glass-body", "theme-light", "has-native-glass");
    applyWebDeskChrome(root);
    expect([...root.classList]).toEqual(["web-desk"]);
  });

  it("renders a retryable error in place of the workspace", () => {
    const root = document.createElement("div");
    renderWebDeskError(root, "Error: Machine is unreachable.");
    expect(root.querySelector("[role=alert] h1")?.textContent).toBe(
      "MonoCode is not connected",
    );
    expect(root.querySelector("p")?.textContent).toBe("Machine is unreachable.");
    expect(root.querySelector("button")?.textContent).toBe("Retry");
  });
});
