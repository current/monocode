// Serves the web desk build (dist-web/) at /desk/ai/app/ with the development
// desk bridge, as the trading site would. With --fixture it also starts an
// isolated fixture host (./fixture-host.mjs) and uses its token.
//
//   node scripts/web-desk/serve.mjs [--fixture] [--port 1442]
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { bridgeOptionsFromEnv, createDeskBridge } from "./bridge.mjs";
import { startFixtureHost } from "./fixture-host.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = join(root, "dist-web");
const BASE = "/desk/ai/app/";
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const port = Number(option("port", process.env.PORT ?? "1442"));

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".ttf": "font/ttf",
};

if (!existsSync(join(dist, "index.html"))) {
  console.error("dist-web/ is missing; run `npm run build:web` first.");
  process.exit(1);
}

let fixture;
const options = bridgeOptionsFromEnv();
if (args.includes("--fixture")) {
  fixture = await startFixtureHost({ port: Number(option("host-port", "3791")) });
  Object.assign(options, {
    hostUrl: fixture.url,
    token: fixture.token,
    projectPath: fixture.projectPath,
  });
}
const bridge = createDeskBridge(options);

const server = createServer((req, res) => {
  void bridge(req, res, () => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
    if (path === "/" || path === "/desk/ai" || path === "/desk/ai/") {
      res.writeHead(302, { Location: BASE }).end();
      return;
    }
    if (!path.startsWith(BASE)) {
      res.writeHead(404).end("Not found");
      return;
    }
    const relative = normalize(path.slice(BASE.length));
    let file = join(dist, relative);
    if (!file.startsWith(dist + sep) && file !== dist) {
      res.writeHead(403).end();
      return;
    }
    // The app is one page; unknown paths below the base load it.
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, "index.html");
    res.writeHead(200, {
      "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
      "Cache-Control": file.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-store",
    });
    createReadStream(file).pipe(res);
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Web desk on http://127.0.0.1:${port}${BASE}`);
});

const stop = async () => {
  server.close();
  await fixture?.stop();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
