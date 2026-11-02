/** Web stand-in for `@tauri-apps/plugin-updater`: the page is updated by its
 * site, so there is never an update to install. */
export type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

export type Update = {
  version: string;
  currentVersion: string;
  body?: string;
  date?: string;
  downloadAndInstall(onEvent?: (event: DownloadEvent) => void): Promise<void>;
  close(): Promise<void>;
};

export async function check(_options?: unknown): Promise<Update | null> {
  return null;
}
