/**
 * Web stand-in for `@tauri-apps/api/event`: an in-page bus. There is no
 * native side, so only events this page emits itself are ever delivered.
 */
export type UnlistenFn = () => void;
export type EventName = string;
export interface Event<T> {
  event: EventName;
  id: number;
  payload: T;
}
export type EventCallback<T> = (event: Event<T>) => void;
export type EventTarget =
  | string
  | { kind: string; label?: string };
export interface Options {
  target?: EventTarget;
}

export const TauriEvent = {
  WINDOW_RESIZED: "tauri://resize",
  WINDOW_MOVED: "tauri://move",
  WINDOW_CLOSE_REQUESTED: "tauri://close-requested",
  WINDOW_DESTROYED: "tauri://destroyed",
  WINDOW_FOCUS: "tauri://focus",
  WINDOW_BLUR: "tauri://blur",
  WINDOW_SCALE_FACTOR_CHANGED: "tauri://scale-change",
  WINDOW_THEME_CHANGED: "tauri://theme-changed",
  WINDOW_CREATED: "tauri://window-created",
  WEBVIEW_CREATED: "tauri://webview-created",
  DRAG_ENTER: "tauri://drag-enter",
  DRAG_OVER: "tauri://drag-over",
  DRAG_DROP: "tauri://drag-drop",
  DRAG_LEAVE: "tauri://drag-leave",
} as const;

const listeners = new Map<string, Set<EventCallback<unknown>>>();
let nextId = 1;

export async function listen<T>(
  event: EventName,
  handler: EventCallback<T>,
  _options?: Options,
): Promise<UnlistenFn> {
  let set = listeners.get(event);
  if (!set) listeners.set(event, (set = new Set()));
  const callback = handler as EventCallback<unknown>;
  set.add(callback);
  return () => {
    set.delete(callback);
  };
}

export async function once<T>(
  event: EventName,
  handler: EventCallback<T>,
  options?: Options,
): Promise<UnlistenFn> {
  const stop = await listen<T>(
    event,
    (value) => {
      stop();
      handler(value);
    },
    options,
  );
  return stop;
}

export async function emit<T>(event: EventName, payload?: T): Promise<void> {
  const set = listeners.get(event);
  if (!set) return;
  const value: Event<unknown> = { event, id: nextId++, payload };
  for (const handler of [...set]) {
    try {
      handler(value);
    } catch (error) {
      console.error(error);
    }
  }
}

export async function emitTo<T>(
  _target: EventTarget,
  event: EventName,
  payload?: T,
): Promise<void> {
  return emit(event, payload);
}
