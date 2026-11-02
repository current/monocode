import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { webDeskBridgePlugin } from "./scripts/web-desk/vite-bridge-plugin.mjs";
import { TAURI_WEB_SHIMS } from "./scripts/web-desk/tauri-shims.mjs";

/** Browser build: every Tauri module resolves to an inert web shim
 * (src/platform/web/tauri) and host calls go through the desk bridge. */
const webShimAliases = () =>
  Object.entries(TAURI_WEB_SHIMS).map(([module, file]) => ({
    find: new RegExp(`^${module.replace(/[/.]/g, "\\$&")}$`),
    replacement: new URL(`./src/platform/web/tauri/${file}`, import.meta.url)
      .pathname,
  }));

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async ({ mode }) => {
  const stable = mode === "stable";
  if (mode === "web") {
    const version = JSON.parse(
      readFileSync(new URL("./package.json", import.meta.url), "utf8"),
    ).version as string;
    return {
      base: "/desk/ai/app/",
      plugins: [
        react(),
        tailwindcss(),
        webDeskBridgePlugin(),
        {
          // Any Tauri module without a web shim fails the build instead of
          // shipping native IPC calls to the browser.
          name: "monocode-web-no-tauri",
          enforce: "pre" as const,
          resolveId(id: string) {
            if (id.startsWith("@tauri-apps/"))
              throw new Error(`No web shim for ${id} (vite.config.ts)`);
            return null;
          },
        },
      ],
      worker: { format: "es" as const },
      define: { __MONOCODE_VERSION__: JSON.stringify(version) },
      resolve: {
        alias: webShimAliases(),
      },
      clearScreen: false,
      build: {
        outDir: "dist-web",
        emptyOutDir: true,
        rollupOptions: { input: { main: "index.html" } },
      },
      server: { port: 1440, strictPort: true, host: host || false },
      preview: { port: 1441, strictPort: true },
    };
  }

  return {
    plugins: [react(), tailwindcss()],
    worker: { format: "es" },
    resolve: {
      alias: [
        ...(mode.startsWith("benchmark")
          ? [
              {
                find: /^@tauri-apps\/api\/core$/,
                replacement: new URL(
                  "./tests/browser/tauriFixture.ts",
                  import.meta.url,
                ).pathname,
              },
            ]
          : []),
        ...(mode === "benchmark-profile"
          ? [{ find: "react-dom/client", replacement: "react-dom/profiling" }]
          : []),
      ],
    },
    clearScreen: false,
    build: {
      rollupOptions: {
        // The quick composer panel loads its own page so it does not boot the
        // whole workspace.
        input: {
          main: "index.html",
          quickComposer: "quick-composer.html",
          monoChat: "mono-chat.html",
          ...(mode.startsWith("benchmark")
            ? { workspaceBenchmark: "tests/browser/workspace-performance.html" }
            : {}),
        },
      },
    },
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: stable
        ? false
        : host
          ? {
              protocol: "ws",
              host,
              port: 1421,
            }
          : undefined,
      watch: {
        ignored: stable ? ["**/*"] : ["**/src-tauri/**"],
      },
    },
  };
});
