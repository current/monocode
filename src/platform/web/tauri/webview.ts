/** Web stand-in for `@tauri-apps/api/webview`: no native drag-drop or zoom. */
import { inertWindow } from "./window";

const current = inertWindow("main");

export function getCurrentWebview() {
  return current;
}
