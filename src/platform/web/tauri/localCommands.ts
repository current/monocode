/**
 * Local commands the web desk answers itself. These are reads whose honest
 * browser answer is "nothing here" (no local session store, no saved
 * workspace, no local skills, reminders or automations) and writes to native
 * window or app state that a browser tab does not have. Anything not listed
 * rejects in `invoke`, exactly as an unavailable native command does.
 */
type Result = { handled: true; value: unknown } | { handled: false };

const EMPTY_LIST = () => [];
const NOTHING = () => null;
const DONE = () => undefined;

const LOCAL: Record<string, (args: Record<string, unknown>) => unknown> = {
  // The local session store is empty: desk sessions live on the host.
  session_list_by_project: EMPTY_LIST,
  session_list_in_flight: EMPTY_LIST,
  session_list_linked: EMPTY_LIST,
  session_search: EMPTY_LIST,
  workspace_get_snapshot: NOTHING,
  workspace_set_snapshot: DONE,
  take_window_transfer: NOTHING,
  // Hidden local features report "none".
  list_skills: EMPTY_LIST,
  list_external_editors: EMPTY_LIST,
  automations_list: EMPTY_LIST,
  automation_runs_recover: DONE,
  notes_list: EMPTY_LIST,
  reminder_list: EMPTY_LIST,
  reminder_take_open: NOTHING,
  reminder_register_window: DONE,
  quick_composer_take: EMPTY_LIST,
  quick_composer_prepare: DONE,
  quick_composer_set_enabled: DONE,
  mobile_status: () => ({ enabled: false }),
  linear_status: () => ({ connected: false }),
  github_monocode_star_status: () => "unavailable",
  git_github_repositories: EMPTY_LIST,
  harness_update_check_claim: () => false,
  // No local provider processes exist to stop.
  harness_kill: DONE,
  // Native window and app state.
  set_window_background_blur: DONE,
  set_window_glass_enabled: DONE,
  set_traffic_lights_visible: DONE,
  set_dock_badge: DONE,
  set_trackpad_zoom_enabled: DONE,
  autosave_set_enabled: DONE,
  keybindings_set_overrides: DONE,
  mono_menu_bar_set_visible: DONE,
};

export function webLocalCommand(
  command: string,
  args: Record<string, unknown>,
): Result {
  const handler = LOCAL[command];
  return handler ? { handled: true, value: handler(args) } : { handled: false };
}

/** The commands answered locally, for tests. */
export const WEB_LOCAL_COMMANDS: readonly string[] = Object.keys(LOCAL);
