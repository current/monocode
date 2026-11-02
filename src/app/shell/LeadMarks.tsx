/**
 * Sidebar identity for /operator leads and the sessions they started (a port
 * of the native shell's lead_marks.rs). A lead row keeps its mode's colour as
 * a left edge, faint border and fill; while one of its agents works, a slow
 * sheen crosses the row. An agent row carries a small mark that leads back
 * to its lead. Under reduced motion only the static tint remains.
 */
import type { MouseEvent as ReactMouseEvent } from "react";
import { CornerDownRight } from "../../shared/ui/icons";

/** Which listed sessions lead others, and each agent's lead. `groups` maps a
 * lead to the sessions it started (see groupStartedSessions). */
export function sessionLeadMarks<T extends { id: string }>(
  groups: ReadonlyMap<string, readonly T[]>,
  busyIds: ReadonlySet<string>,
): {
  leads: ReadonlyMap<string, { working: boolean }>;
  agentLead: ReadonlyMap<string, string>;
} {
  const leads = new Map<string, { working: boolean }>();
  const agentLead = new Map<string, string>();
  for (const [lead, children] of groups) {
    const agents = children.filter((child) => child.id !== lead);
    if (!agents.length) continue;
    leads.set(lead, { working: agents.some((child) => busyIds.has(child.id)) });
    for (const child of agents) agentLead.set(child.id, lead);
  }
  return { leads, agentLead };
}

/** Drawn under a lead row's content, inside its rounded card. */
export function LeadRowTint({ working }: { working: boolean }) {
  return (
    <span
      aria-hidden
      data-lead-tint
      className="pointer-events-none absolute inset-0 overflow-hidden rounded-md bg-sky-500/5 ring-1 ring-inset ring-sky-500/20 dark:bg-sky-400/5 dark:ring-sky-400/20"
    >
      <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-sky-500 dark:bg-sky-400" />
      {working ? <span data-lead-sheen className="sidebar-lead-sheen" /> : null}
    </span>
  );
}

/** An agent row's mark in its lead's colour; clicking it opens the lead. */
export function AgentOfMark({
  leadTitle,
  onOpen,
}: {
  leadTitle: string;
  onOpen: () => void;
}) {
  const label = `Agent of ${leadTitle}`;
  return (
    <button
      type="button"
      data-no-drag
      data-agent-of
      data-tauri-drag-region="false"
      title={label}
      aria-label={label}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event: ReactMouseEvent) => {
        event.stopPropagation();
        onOpen();
      }}
      className="relative -mr-0.5 flex h-4 shrink-0 items-center gap-0.5 rounded px-0.5 text-sky-700 after:absolute after:-inset-1 after:content-[''] hover:bg-content/10 focus-visible:outline-2 focus-visible:outline-accent dark:text-sky-200/90"
    >
      <CornerDownRight className="size-3" strokeWidth={1.75} />
      <span className="size-1 rounded-full bg-current" />
    </button>
  );
}
