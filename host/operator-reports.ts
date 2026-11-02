import { createHash } from "node:crypto";
import type { HostSession } from "../src/features/connections/model/protocol";
import type { HostStore } from "./store";

/** Characters of each worker's final answer included in a report. */
export const REPORT_CHARS = 12_000;
/** How often a report waiting on a lead with an unsent draft retries. */
const RETRY_MS = 10_000;

export function limitText(text: string, count = REPORT_CHARS): string {
  const chars = [...text];
  if (chars.length <= count) return text;
  return `${chars.slice(0, Math.max(0, count - 13)).join("")}\n\n[truncated]`;
}

/** The assistant's answer in a session's latest turn. */
export function finalAnswer(value: HostSession): string {
  const blocks = value.session.blocks;
  let start = 0;
  for (let i = blocks.length - 1; i >= 0; i--)
    if (blocks[i].role === "user" && !blocks[i].draft) {
      start = i + 1;
      break;
    }
  const turn = blocks.slice(start);
  const answer = turn
    .filter((block) => block.role === "assistant" && !block.internal)
    .map((block) => block.text.trim().replace(/\r\n?/g, "\n"))
    .filter(Boolean)
    .join("\n\n");
  if (answer) return answer;
  const system = turn.filter((block) => block.role === "system").at(-1);
  return system?.text.trim() || "No final answer";
}

export function reportMessage(
  entries: { id: string; title: string; answer: string }[],
): string {
  const one = entries.length === 1;
  return `[Delegated work completed]\n${one ? "The session" : "All sessions"} you started ${
    one ? "has" : "have"
  } stopped. Inspect the results below and give an integrated update; use sessions.read for more detail.\n\n${entries
    .map((e) => `Session ${e.id}: ${e.title}\n${limitText(e.answer)}`)
    .join("\n\n")}`;
}

/**
 * Completion reports for /operator leads. A lead that starts sessions ends
 * its turn instead of polling. When the lead is idle and every session it
 * started (and has not yet heard back from) has stopped, it receives one
 * message with their final answers. Pending launches live in the host
 * database, so a restart does not lose them.
 */
export class OperatorReports {
  private retry?: ReturnType<typeof setTimeout>;
  private checking = false;
  private closed = false;

  constructor(
    private readonly store: HostStore,
    private readonly options: {
      /** Starts the lead's report turn. Throws when the lead cannot take it. */
      deliver: (leadId: string, text: string, commandId: string) => void;
      /** The engine still has a turn in flight for this session. */
      isRunning: (id: string) => boolean;
    },
  ) {
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS operator_reports (child_id TEXT PRIMARY KEY, lead_id TEXT NOT NULL, started_at INTEGER NOT NULL)",
    );
  }

  /** Child session id to the lead awaiting its report. */
  pending(): Map<string, string> {
    return new Map(
      this.store.db
        .prepare("SELECT child_id, lead_id FROM operator_reports ORDER BY started_at, child_id")
        .all()
        .map((row) => [String(row.child_id), String(row.lead_id)]),
    );
  }

  /** Record a session a lead started (or continued) so its result is reported. */
  track(childId: string, leadId: string): void {
    this.store.db
      .prepare(
        "INSERT INTO operator_reports VALUES (?, ?, ?) ON CONFLICT(child_id) DO UPDATE SET lead_id=excluded.lead_id, started_at=excluded.started_at",
      )
      .run(childId, leadId, Date.now());
  }

  /** The child was stopped, cancelled or deleted; it drops out of its report. */
  dismiss(childId: string): void {
    const removed = Number(
      this.store.db.prepare("DELETE FROM operator_reports WHERE child_id=?").run(childId)
        .changes,
    );
    if (removed) this.check();
  }

  /** A deleted lead has nobody waiting for its reports. */
  forgetLead(leadId: string): void {
    this.store.db.prepare("DELETE FROM operator_reports WHERE lead_id=?").run(leadId);
  }

  private find(id: string): HostSession | undefined {
    try {
      return this.store.session(id);
    } catch {
      return undefined;
    }
  }

  private stopped(id: string): boolean {
    const value = this.find(id);
    return !value || (value.status !== "running" && !this.options.isRunning(id));
  }

  /** Deliver every report whose whole batch has stopped and whose lead is idle. */
  check(): void {
    if (this.checking || this.closed) return;
    this.checking = true;
    let waiting = false;
    try {
      const byLead = new Map<string, string[]>();
      for (const [child, lead] of this.pending()) {
        const list = byLead.get(lead);
        if (list) list.push(child);
        else byLead.set(lead, [child]);
      }
      for (const [leadId, children] of byLead) {
        const lead = this.find(leadId);
        if (!lead) {
          this.forgetLead(leadId);
          continue;
        }
        if (!children.every((child) => this.stopped(child))) continue;
        if (lead.status === "running" || this.options.isRunning(leadId)) continue;
        if (lead.session.blocks.some((block) => block.draft)) {
          waiting = true;
          continue;
        }
        const entries = children
          .map((id) => {
            const value = this.find(id);
            return value
              ? { id, title: value.session.title, answer: finalAnswer(value) }
              : undefined;
          })
          .filter((entry) => entry !== undefined);
        const remove = () =>
          this.store.transaction(() => {
            for (const child of children)
              this.store.db
                .prepare("DELETE FROM operator_reports WHERE child_id=? AND lead_id=?")
                .run(child, leadId);
          });
        if (!entries.length) {
          remove();
          continue;
        }
        // The same batch always maps to the same command, so a report that
        // was delivered just before a crash is not sent twice.
        const commandId = `report-${createHash("sha256")
          .update(`${leadId}\n${[...children].sort().join("\n")}\n${children
            .map((c) => this.find(c)?.revision ?? 0)
            .join(",")}`)
          .digest("hex")
          .slice(0, 32)}`;
        try {
          this.options.deliver(leadId, reportMessage(entries), commandId);
        } catch (error) {
          console.error(
            "Operator report delivery failed:",
            error instanceof Error ? error.message : "unknown error",
          );
          waiting = true;
          continue;
        }
        remove();
      }
    } finally {
      this.checking = false;
    }
    if (waiting && !this.retry && !this.closed) {
      this.retry = setTimeout(() => {
        this.retry = undefined;
        this.check();
      }, RETRY_MS);
      this.retry.unref?.();
    }
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.retry);
  }
}
