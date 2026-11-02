/** Web stand-in for `@tauri-apps/api/app`. */
export const BundleType = {
  Nsis: "nsis",
  Msi: "msi",
  Deb: "deb",
  Rpm: "rpm",
  AppImage: "appimage",
  App: "app",
} as const;

export async function getVersion(): Promise<string> {
  return __MONOCODE_VERSION__;
}

export async function getName(): Promise<string> {
  return "MonoCode";
}

export async function getTauriVersion(): Promise<string> {
  return "";
}

/** The web desk is not an installed bundle; the updater stays off. */
export async function getBundleType(): Promise<undefined> {
  return undefined;
}
