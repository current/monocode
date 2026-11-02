/**
 * Web stand-in for `@tauri-apps/api/core`. The web desk has no native side:
 * host traffic goes through the same-origin bridge, the machine list is the
 * one desk host, and every command that would read or run on this computer
 * rejects, as a command does when the desktop's native side refuses it.
 */
import { bridgeRpc, deskMachine } from "../bridge";
import { webLocalCommand } from "./localCommands";

export type InvokeArgs = Record<string, unknown> | number[] | ArrayBuffer | Uint8Array;
export interface InvokeOptions {
  headers?: HeadersInit | Record<string, string>;
}

export const NOT_ON_WEB = "Not available in the web desk";

type Handler = (args: Record<string, unknown>) => unknown;

const handlers: Record<string, Handler> = {
  remote_request: ({ method, params }) => bridgeRpc(String(method ?? ""), params),
  remote_machines: async () => [await deskMachine()],
  // The bridge owns the one connection; nothing is added or removed here.
  remote_connect: async () => deskMachine(),
};

export async function invoke<T>(
  command: string,
  args?: InvokeArgs,
  _options?: InvokeOptions,
): Promise<T> {
  const record =
    args &&
    typeof args === "object" &&
    !Array.isArray(args) &&
    !ArrayBuffer.isView(args) &&
    !(args instanceof ArrayBuffer)
      ? (args as Record<string, unknown>)
      : {};
  const handler = handlers[command];
  if (handler) return (await handler(record)) as T;
  const local = webLocalCommand(command, record);
  if (local.handled) return (await local.value) as T;
  throw `${NOT_ON_WEB}: ${command}`;
}

export function isTauri(): boolean {
  return false;
}

/** No local file server exists in a browser; local media renders as missing. */
export function convertFileSrc(_filePath: string, _protocol = "asset"): string {
  return "";
}

export class Channel<T = unknown> {
  id = 0;
  onmessage: (response: T) => void = () => {};
  toJSON(): string {
    return `__CHANNEL__:${this.id}`;
  }
}

export class Resource {
  constructor(readonly rid: number) {}
  async close(): Promise<void> {}
}

export class PluginListener {
  async unregister(): Promise<void> {}
}

export async function addPluginListener(): Promise<PluginListener> {
  return new PluginListener();
}

export const SERIALIZE_TO_IPC_FN = "__TAURI_TO_IPC_KEY__";

export function transformCallback(): number {
  return 0;
}
