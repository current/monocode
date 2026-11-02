/**
 * Web stand-in for `@tauri-apps/plugin-dialog`. Confirmations use the
 * browser's own dialogs; native file pickers do not exist, so `open` returns
 * no selection (the same result as a cancelled picker).
 */
type MessageOptions = { title?: string; kind?: string; okLabel?: string };

const text = (message: string, options?: string | MessageOptions) => {
  const title = typeof options === "string" ? options : options?.title;
  return title && title !== "MonoCode" ? `${title}\n\n${message}` : message;
};

export async function ask(
  message: string,
  options?: string | MessageOptions,
): Promise<boolean> {
  return window.confirm(text(message, options));
}

export async function confirm(
  message: string,
  options?: string | MessageOptions,
): Promise<boolean> {
  return window.confirm(text(message, options));
}

export async function message(
  message: string,
  options?: string | MessageOptions,
): Promise<string> {
  window.alert(text(message, options));
  return "Ok";
}

export async function open(_options?: unknown): Promise<null> {
  return null;
}

export async function save(_options?: unknown): Promise<null> {
  return null;
}
