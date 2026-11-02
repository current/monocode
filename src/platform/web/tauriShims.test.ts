import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TAURI_WEB_SHIMS } from "../../../scripts/web-desk/tauri-shims.mjs";
import { BRIDGE_BASE, setBridgeFetch } from "./bridge";
import { convertFileSrc, invoke, isTauri, NOT_ON_WEB } from "./tauri/core";
import { emit, listen, once } from "./tauri/event";
import { getCurrentWindow } from "./tauri/window";
import { getCurrentWebview } from "./tauri/webview";
import { check } from "./tauri/updater";
import { getBundleType } from "./tauri/app";
import { WEB_LOCAL_COMMANDS } from "./tauri/localCommands";

const SRC = join(__dirname, "..", "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Every Tauri module the app imports, with the names it takes from each. */
function tauriImports(): Map<string, Set<string>> {
  const imports = new Map<string, Set<string>>();
  for (const file of sourceFiles(SRC)) {
    if (file.includes(join("platform", "web"))) continue;
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(
      /import\s+(type\s+)?(?:\{([^}]*)\}|\*\s+as\s+\w+|\w+)\s*from\s*"(@tauri-apps\/[^"]+)"/g,
    )) {
      const names = imports.get(match[3]) ?? new Set<string>();
      imports.set(match[3], names);
      if (match[1] || !match[2]) continue;
      for (const part of match[2].split(",")) {
        const spec = part.trim();
        if (!spec || spec.startsWith("type ")) continue;
        names.add(spec.split(/\s+as\s+/)[0].trim());
      }
    }
    for (const match of text.matchAll(/import\(\s*"(@tauri-apps\/[^"]+)"\s*\)/g))
      if (!imports.has(match[1])) imports.set(match[1], new Set());
  }
  return imports;
}

afterEach(() => setBridgeFetch(undefined));

describe("Tauri web shims", () => {
  it("cover every Tauri module and value the app imports", async () => {
    const imports = tauriImports();
    expect(imports.size).toBeGreaterThan(5);
    for (const [module, names] of imports) {
      const file = (TAURI_WEB_SHIMS as Record<string, string>)[module];
      expect(file, `no web shim for ${module}`).toBeTruthy();
      const shim = await import(`./tauri/${file.replace(/\.ts$/, "")}.ts`);
      for (const name of names)
        expect(shim, `${module} shim lacks ${name}`).toHaveProperty(name);
    }
  });

  it("routes remote_request through the bridge and lists the one desk machine", async () => {
    const bodies: unknown[] = [];
    setBridgeFetch((async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === `${BRIDGE_BASE}/info`)
        return Response.json({ machineId: "desk", name: "Desk", projectPath: "/srv" });
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      return Response.json({
        result:
          body.method === "environment.describe"
            ? { environmentId: "env-1" }
            : [{ id: "p1", cwd: "/srv", name: "srv" }],
      });
    }) as unknown as typeof fetch);
    await expect(
      invoke("remote_request", {
        machineId: "desk",
        method: "projects.list",
        params: { a: 1 },
      }),
    ).resolves.toEqual([{ id: "p1", cwd: "/srv", name: "srv" }]);
    expect(bodies).toContainEqual({ method: "projects.list", params: { a: 1 } });
    await expect(invoke("remote_machines")).resolves.toEqual([
      expect.objectContaining({ id: "desk", environmentId: "env-1" }),
    ]);
  });

  it("rejects local-only commands the way an unavailable native command does", async () => {
    for (const command of ["pty_spawn", "read_text_file", "remote_ssh_begin", "mcp_add"])
      await expect(invoke(command, {})).rejects.toBe(`${NOT_ON_WEB}: ${command}`);
    await expect(invoke("remote_disconnect", { machineId: "desk" })).rejects.toMatch(
      NOT_ON_WEB,
    );
  });

  it("answers local stores as empty", async () => {
    expect(WEB_LOCAL_COMMANDS).toContain("session_list_by_project");
    await expect(invoke("session_list_by_project", { cwd: "x" })).resolves.toEqual([]);
    await expect(invoke("workspace_get_snapshot")).resolves.toBeNull();
    await expect(invoke("mobile_status")).resolves.toEqual({ enabled: false });
    await expect(invoke("set_window_background_blur", { radius: 4 })).resolves.toBeUndefined();
  });

  it("is not Tauri, has no local files, updates or bundle", async () => {
    expect(isTauri()).toBe(false);
    expect(convertFileSrc("/Users/me/a.png")).toBe("");
    await expect(check()).resolves.toBeNull();
    await expect(getBundleType()).resolves.toBeUndefined();
  });

  it("delivers in-page events until unlistened", async () => {
    const seen: unknown[] = [];
    const stop = await listen<number>("tick", (event) => seen.push(event.payload));
    await once<number>("tick", (event) => seen.push(`once:${event.payload}`));
    await emit("tick", 1);
    stop();
    await emit("tick", 2);
    expect(seen).toEqual([1, "once:1"]);
  });

  it("gives inert windows that are never mistaken for promises", async () => {
    const win = getCurrentWindow();
    expect(win.label).toBe("main");
    expect((win as { then?: unknown }).then).toBeUndefined();
    const unlisten = await (win.onResized as () => Promise<() => void>)();
    expect(typeof unlisten).toBe("function");
    await expect((win.isFullscreen as () => Promise<boolean>)()).resolves.toBe(false);
    await expect((win.minimize as () => Promise<void>)()).resolves.toBeUndefined();
    const drop = vi.fn();
    const stop = await (
      getCurrentWebview().onDragDropEvent as (handler: unknown) => Promise<() => void>
    )(drop);
    stop();
    expect(drop).not.toHaveBeenCalled();
  });
});
