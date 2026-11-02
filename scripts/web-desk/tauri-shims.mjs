// Which web shim (src/platform/web/tauri/<file>) stands in for each Tauri
// module in the web desk build. vite.config.ts aliases them; a test checks
// that every Tauri import in src/ has one with the names it uses.
export const TAURI_WEB_SHIMS = {
  "@tauri-apps/api/core": "core.ts",
  "@tauri-apps/api/event": "event.ts",
  "@tauri-apps/api/window": "window.ts",
  "@tauri-apps/api/webview": "webview.ts",
  "@tauri-apps/api/webviewWindow": "webviewWindow.ts",
  "@tauri-apps/api/app": "app.ts",
  "@tauri-apps/plugin-dialog": "dialog.ts",
  "@tauri-apps/plugin-opener": "opener.ts",
  "@tauri-apps/plugin-process": "process.ts",
  "@tauri-apps/plugin-updater": "updater.ts",
};
