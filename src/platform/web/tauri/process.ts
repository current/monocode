/** Web stand-in for `@tauri-apps/plugin-process`. */
export async function relaunch(): Promise<void> {
  window.location.reload();
}

export async function exit(_code = 0): Promise<void> {}
