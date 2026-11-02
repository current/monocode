# Web desk (browser build)

`npm run build:web` builds the MonoCode UI for a browser into `dist-web/`, served at `/desk/ai/app/`. It shows one MonoCode host project (session list, transcript, tool calls, composer, model picker) through an HTTP bridge on the embedding site. The desktop build is unchanged.

## How it works

- `vite --mode web` aliases every `@tauri-apps/*` module to `src/platform/web/tauri/*` (map: `scripts/web-desk/tauri-shims.mjs`). A Tauri import without a shim fails the build.
- `invoke("remote_request")` posts `{method, params}` to `POST /api/v1/desk-ai/host/rpc` (same-origin cookies, no `Authorization` header). The site's bridge adds `version`, `environmentId` and the device token and returns the host's JSON. The browser never holds the token. `remote_machines` returns the one machine from `GET /api/v1/desk-ai/host/info` (`{machineId, name, projectPath}`).
- At boot (`src/platform/web/boot.ts`) the page opens `projectPath` on the host (`projects.open`) and makes it the only project.
- `IS_WEB` / `FEATURES` in `src/platform/runtime.ts` hide local-only features: the project rail and local projects, global search, terminals, Monos, automations, inbox, notes, Settings, the updater and update notices, reminders, connection management, native window controls, the non-macOS menu bar, the quick composer and the usage footer. Operator mode, skills, `@` mentions and local slash commands are already off for host projects. Every other local command rejects (`Not available in the web desk: <command>`) or returns an empty local store (`src/platform/web/tauri/localCommands.ts`).
- Theme bridge (`src/platform/web/deskTheme.css`): `--desk-bg`, `--desk-surface`, `--desk-border`, `--desk-text`, `--desk-text-muted`, `--desk-accent`, `--desk-heading`, `--desk-font-ui`, `--desk-font-heading` and `--desk-font-mono` default to the Legend palette and feed MonoCode's own tokens. A same-origin parent page can override them on the frame's `<html>` element. Fonts are not bundled; the page uses Inter and Newsreader when available.

## Development

```sh
npm run host:build
node build/host/monocode-host.mjs serve            # or: start
node build/host/monocode-host.mjs pair --name web-desk
MONOCODE_DESK_TOKEN=<token> MONOCODE_DESK_PROJECT=/path/on/host npm run dev:web
# open http://localhost:1440/desk/ai/app/
```

`MONOCODE_DESK_HOST_URL` defaults to `http://127.0.0.1:3774`. `npm run dev:web:host` starts an isolated fixture host instead (temporary HOME and data directory, fake `claude`, every other provider CLI stubbed) and prints the variables to export. `npm run serve:web -- --fixture` serves `dist-web/` behind the same development bridge (`scripts/web-desk/bridge.mjs`); production uses the site's bridge.

## Tests

- `npm run check:web` includes `src/platform/web/*.test.ts` (shims, bridge, boot). On Node 26 run it as `NODE_OPTIONS=--no-experimental-webstorage npm run check:web`.
- `npm run test:web-desk` builds the host and `dist-web/`, starts the fixture host and runs `tests/web-desk/web-desk.spec.ts`. It sends a prompt to the fake Claude, checks the tool call and markdown reply, checks that hidden features are absent and that every request is same-origin without credentials, and saves 2x screenshots at 1440 and 390 px to `output/web-desk/`. If this Playwright version's Chromium is not downloaded, it uses the installed Chrome.
