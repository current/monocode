/**
 * Which shell this UI runs in. The desktop app runs inside Tauri; the web
 * desk (`vite --mode web`) runs in a normal browser tab and reaches one
 * MonoCode host through a same-origin HTTP bridge (src/platform/web).
 *
 * Vite replaces `import.meta.env.MODE` at build time, so desktop builds drop
 * every web-only branch and the web build drops desktop-only ones.
 */
export const IS_WEB: boolean = import.meta.env.MODE === "web";

/**
 * What the web desk can offer. Everything that reads or runs on the computer
 * showing the UI (local projects, terminals, operator mode, skills, Monos,
 * automations, the inbox, the updater, connection management) is hidden.
 */
export const FEATURES = {
  localProjects: !IS_WEB,
  terminals: !IS_WEB,
  operator: !IS_WEB,
  skills: !IS_WEB,
  monos: !IS_WEB,
  automations: !IS_WEB,
  inbox: !IS_WEB,
  notes: !IS_WEB,
  updater: !IS_WEB,
  connections: !IS_WEB,
  localSettings: !IS_WEB,
  windowControls: !IS_WEB,
  multiWindow: !IS_WEB,
} as const;

/** Below this viewport width the web desk starts with its sidebar closed. */
export const WEB_NARROW_WIDTH = 640;
