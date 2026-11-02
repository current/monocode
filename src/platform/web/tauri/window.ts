/**
 * Web stand-in for `@tauri-apps/api/window`. The page is not a native window:
 * listeners register and never fire, state queries answer "not maximized /
 * not fullscreen", and window actions do nothing.
 */
import type { UnlistenFn } from "./event";

const noop = () => {};

/** One inert object answers every window method the UI calls. */
export function inertWindow(label = "main"): Record<string, unknown> {
  return new Proxy({ label } as Record<string, unknown>, {
    get(target, property) {
      if (typeof property !== "string") return undefined;
      if (property in target) return target[property];
      // `then` must stay undefined so the object is never treated as a promise.
      if (property === "then") return undefined;
      if (property === "listen" || property === "once" || /^on[A-Z]/.test(property))
        return async (): Promise<UnlistenFn> => noop;
      if (/^is[A-Z]/.test(property)) return async () => false;
      if (property === "scaleFactor") return async () => window.devicePixelRatio || 1;
      if (property === "title") return async () => document.title;
      return async () => undefined;
    },
  });
}

const current = inertWindow("main");

export function getCurrentWindow() {
  return current;
}

export function getAllWindows() {
  return [current];
}

export class LogicalSize {
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
}
export class PhysicalSize extends LogicalSize {}
export class LogicalPosition {
  constructor(
    readonly x: number,
    readonly y: number,
  ) {}
}
export class PhysicalPosition extends LogicalPosition {}

export const ProgressBarStatus = {
  None: "none",
  Normal: "normal",
  Indeterminate: "indeterminate",
  Paused: "paused",
  Error: "error",
} as const;
