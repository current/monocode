/** Web stand-in for `@tauri-apps/api/webviewWindow`: one inert page window. */
import { inertWindow } from "./window";

const current = inertWindow("main");

export function getCurrentWebviewWindow() {
  return current;
}

export class WebviewWindow {
  static getByLabel() {
    return Promise.resolve(null);
  }
}
