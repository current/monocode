// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { groupStartedSessions, SessionCard } from "./Sidebar";
import { sessionLeadMarks } from "./LeadMarks";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

type CardProps = ComponentProps<typeof SessionCard>;
function card(id: string, title: string, extra: Partial<CardProps> = {}) {
  const props = {
    session: { id, title, harness: "claude", cwd: "/p", updatedAt: 0, createdAt: 0 },
    isActive: false,
    isSelected: false,
    busy: false,
    done: false,
    linkedUpdate: false,
    needsApproval: false,
    now: 0,
    onSelect: vi.fn(),
    ...extra,
  } as unknown as CardProps;
  return { props, element: createElement(SessionCard, props) };
}

describe("sessionLeadMarks", () => {
  it("marks leads, their working state and each agent's lead", () => {
    const rows = [{ id: "lead" }, { id: "app-lead-a1" }, { id: "app-lead-b2" }, { id: "solo" }];
    const marks = sessionLeadMarks(groupStartedSessions(rows).byParent, new Set(["app-lead-b2"]));
    expect([...marks.leads]).toEqual([["lead", { working: true }]]);
    expect(marks.agentLead.get("app-lead-a1")).toBe("lead");
    expect(marks.agentLead.get("app-lead-b2")).toBe("lead");
    expect(marks.agentLead.has("solo")).toBe(false);
    const idle = sessionLeadMarks(groupStartedSessions(rows).byParent, new Set());
    expect(idle.leads.get("lead")).toEqual({ working: false });
  });
});

describe("sidebar lead and agent rows", () => {
  for (const dense of [false, true]) {
    it(`tints a lead row and sheens it while an agent works (${dense ? "inset" : "classic"})`, () => {
      const idle = card("lead", "Lead thread", { dense, leadWorking: false });
      act(() => root.render(idle.element));
      const tint = container.querySelector("[data-lead-tint]")!;
      expect(tint).not.toBeNull();
      expect(tint.className).toContain("bg-sky-500/5");
      expect(container.querySelector("[data-lead-sheen]")).toBeNull();
      act(() => root.render(card("lead", "Lead thread", { dense, leadWorking: true }).element));
      expect(container.querySelector("[data-lead-sheen]")?.className).toBe("sidebar-lead-sheen");
    });

    it(`marks an agent row and opens its lead on click (${dense ? "inset" : "classic"})`, () => {
      const agent = card("app-lead-a1", "Worker", {
        dense,
        agentOfId: "lead",
        agentOfTitle: "Lead thread",
      });
      act(() => root.render(agent.element));
      expect(container.querySelector("[data-lead-tint]")).toBeNull();
      const mark = container.querySelector<HTMLButtonElement>('[aria-label="Agent of Lead thread"]')!;
      expect(mark).not.toBeNull();
      expect(mark.title).toBe("Agent of Lead thread");
      act(() => mark.click());
      expect(agent.props.onSelect).toHaveBeenCalledTimes(1);
      expect(agent.props.onSelect).toHaveBeenCalledWith("lead", {
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
      });
    });
  }

  it("leaves plain rows unmarked", () => {
    act(() => root.render(card("solo", "Solo").element));
    expect(container.querySelector("[data-lead-tint]")).toBeNull();
    expect(container.querySelector("[data-agent-of]")).toBeNull();
  });

  it("drops the sheen under reduced motion, keeping the static tint", () => {
    // Vitest stubs CSS imports; read the stylesheet the app ships.
    const css = readFileSync(join(process.cwd(), "src/styles/index.css"), "utf8");
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.sidebar-lead-sheen \{\s*display: none;/,
    );
  });
});
