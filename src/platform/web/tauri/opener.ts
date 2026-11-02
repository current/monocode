/** Web stand-in for `@tauri-apps/plugin-opener`: links open in a new tab;
 * local paths cannot be revealed from a browser. */
export async function openUrl(url: string | URL): Promise<void> {
  const value = String(url);
  if (!/^(https?:|mailto:)/i.test(value)) return;
  window.open(value, "_blank", "noopener,noreferrer");
}

export async function openPath(_path: string): Promise<void> {}

export async function revealItemInDir(_path: string | string[]): Promise<void> {}
