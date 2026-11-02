import { build } from "esbuild";
import { copyFile } from "node:fs/promises";

await build({
  entryPoints: ["host/cli.ts"],
  outfile: "build/host/monocode-host.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  loader: { ".ps1": "text" },
  // Shared UI modules read Vite's build mode (src/platform/runtime.ts).
  define: {
    "import.meta.hot": "undefined",
    "import.meta.env.MODE": JSON.stringify("host"),
  },
  sourcemap: true,
});
await copyFile("host/provider-guard.mjs", "build/host/provider-guard.mjs");
