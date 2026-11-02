import type { HostProject, RemoteMachine } from "../../features/connections/model/protocol";
import { rememberRemoteProject } from "../../features/connections/model/remoteProjects";
import { bridgeRpc, deskHostInfo, deskMachine, type DeskHostInfo } from "./bridge";
import "./deskTheme.css";

export type WebDeskBoot = {
  /** The rail key (`remote://<environment>/<path>`) of the desk project. */
  projectKey: string;
  machine: RemoteMachine;
  info: DeskHostInfo;
};

const RECENTS_KEY = "monocode.recentProjects";
const RAIL_ORDER_KEY = "monocode.projectRailOrder";
const RAIL_PINNED_KEY = "monocode.projectRailPinned";

/**
 * Opens the desk host's checkout and makes it the only project this page
 * knows, so the workspace boots straight into its sessions.
 */
export async function prepareWebDesk(): Promise<WebDeskBoot> {
  applyWebDeskChrome();
  const [info, machine] = await Promise.all([deskHostInfo(), deskMachine()]);
  const project = await bridgeRpc<HostProject>("projects.open", {
    cwd: info.projectPath,
  });
  const remote = rememberRemoteProject(machine.environmentId, project);
  try {
    localStorage.setItem(
      RECENTS_KEY,
      JSON.stringify([{ path: remote.key, openedAt: Date.now() }]),
    );
    localStorage.setItem(RAIL_ORDER_KEY, JSON.stringify([remote.key]));
    localStorage.setItem(RAIL_PINNED_KEY, JSON.stringify([]));
  } catch {
    /* storage is unavailable: the project still opens from the boot result */
  }
  return { projectKey: remote.key, machine, info };
}

/** Shown in place of the workspace when the bridge cannot be reached. */
export function renderWebDeskError(root: HTMLElement, reason: unknown) {
  const text = String(reason).replace(/^Error: /, "");
  root.replaceChildren();
  const box = document.createElement("div");
  box.className = "web-desk-boot-error";
  box.setAttribute("role", "alert");
  const title = document.createElement("h1");
  title.textContent = "MonoCode is not connected";
  const detail = document.createElement("p");
  detail.textContent = text;
  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = "Retry";
  retry.addEventListener("click", () => window.location.reload());
  box.append(title, detail, retry);
  root.append(box);
}

/** The Legend theme bridge and an opaque, dark page: no native glass here. */
export function applyWebDeskChrome(root: HTMLElement = document.documentElement) {
  root.classList.add("web-desk");
  root.classList.remove("glass-body", "theme-light", "has-native-glass");
}
