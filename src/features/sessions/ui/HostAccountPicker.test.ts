// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostAccount } from "../../connections/model/protocol";

vi.mock("../../../integrations/harness/core/availability", () => ({
  getHarnessAvailabilitySnapshot: () => 0,
  hasProbedHarnessAvailability: () => true,
  isHarnessAvailable: () => true,
  probeHarnessAvailability: () => Promise.resolve(),
  subscribeHarnessAvailability: () => () => undefined,
}));

vi.mock("../../../integrations/harness/core/registry", () => ({
  refreshHarnessCatalogs: () => Promise.resolve(),
}));

vi.mock("../../../shared/ui/Popover", () => ({
  Popover: ({
    children,
    role,
    className,
    onKeyDown,
    ...props
  }: {
    children: ReactNode;
    role?: string;
    className?: string;
    onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
    "aria-label"?: string;
  }) =>
    createElement(
      "div",
      { role, className, onKeyDown, "aria-label": props["aria-label"] },
      children,
    ),
}));

import { HostAccountPicker, hostAccountStatus } from "./HostAccountPicker";
import {
  LOCAL_MODEL_SOURCE,
  ModelSourceContext,
  type ModelSource,
} from "./modelSource";

const NOW = Date.parse("2026-11-02T12:00:00Z");
const ACCOUNTS: HostAccount[] = [
  {
    id: "claude-main",
    label: "Claude (main)",
    harness: "claude",
    state: "ok",
    fiveHour: { usedPercent: 40, resetsAt: NOW + 3_600_000 },
    weekly: { usedPercent: 12, resetsAt: NOW + 86_400_000 },
    checkedAt: NOW,
  },
  {
    id: "claude-alt",
    label: "Claude (alt)",
    harness: "claude",
    state: "exhausted",
    detail: "Weekly limit reached",
    weekly: { usedPercent: 100, resetsAt: NOW + 1_800_000 },
    checkedAt: NOW,
  },
  {
    id: "claude-alt-2",
    label: "Claude (alt-2)",
    harness: "claude",
    state: "idle",
    detail: "Refreshes on next use",
    checkedAt: NOW,
  },
  {
    id: "codex-main",
    label: "Codex (main)",
    harness: "codex",
    state: "ok",
    fiveHour: { usedPercent: 5 },
    checkedAt: NOW,
  },
];

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

function render(source: ModelSource, harness: "claude" | "codex" = "claude") {
  act(() => {
    root.render(
      createElement(
        ModelSourceContext.Provider,
        { value: source },
        createElement(HostAccountPicker, { harness }),
      ),
    );
  });
}

function hostSource(
  accounts: Partial<NonNullable<ModelSource["accounts"]>> = {},
): ModelSource & { accounts: NonNullable<ModelSource["accounts"]> } {
  return {
    ...LOCAL_MODEL_SOURCE,
    id: "remote:test",
    refresh: vi.fn(),
    accounts: { list: ACCOUNTS, select: vi.fn(), ...accounts },
  };
}

const trigger = () =>
  host.querySelector<HTMLButtonElement>("[data-host-account-picker-trigger]");
const rows2 = () => host.textContent ?? "";
const options = () =>
  [...host.querySelectorAll<HTMLButtonElement>('[role="option"]')];

describe("HostAccountPicker", () => {
  it("is hidden for local sessions and hosts without accounts", () => {
    render(LOCAL_MODEL_SOURCE);
    expect(trigger()).toBeNull();
    render(hostSource({ list: ACCOUNTS.filter((a) => a.harness === "codex") }));
    expect(trigger()).toBeNull();
  });

  it("lists the harness's accounts with usage and disables exhausted ones", () => {
    const source = hostSource({ selected: "claude-main" });
    render(source);
    expect(trigger()?.textContent).toContain("Claude (main)");
    act(() => trigger()!.click());
    expect(source.refresh).toHaveBeenCalledWith(["claude"]);
    expect(host.textContent).toContain("Claude Code accounts");
    expect(rows2()).toContain("back in 30m");
    const rows = options();
    expect(rows.map((row) => row.querySelector("span span")?.textContent)).toEqual([
      "Default login",
      "Claude (main)",
      "Claude (alt)",
      "Claude (alt-2)",
    ]);
    expect(host.textContent).not.toContain("Codex (main)");
    expect(rows[1].getAttribute("aria-selected")).toBe("true");
    expect(rows[1].querySelectorAll('[role="progressbar"]')).toHaveLength(2);
    expect(rows[1].textContent).toContain("Ready");
    expect(rows[2].getAttribute("aria-disabled")).toBe("true");
    expect(rows[2].title).toBe("Weekly limit reached");
    expect(rows[2].textContent).toContain("Exhausted");
    expect(rows[3].textContent).toContain("Refreshes on next use");
    expect(rows[3].getAttribute("aria-disabled")).toBeNull();

    act(() => rows[2].click());
    expect(source.accounts.select).not.toHaveBeenCalled();
    act(() => rows[3].click());
    expect(source.accounts.select).toHaveBeenCalledWith("claude-alt-2");
  });

  it("selects the default login as no account", () => {
    const source = hostSource({ selected: "claude-main" });
    render(source);
    act(() => trigger()!.click());
    act(() => options()[0].click());
    expect(source.accounts.select).toHaveBeenCalledWith(undefined);
  });

  it("skips disabled rows with the keyboard", () => {
    const source = hostSource({ selected: "claude-main" });
    render(source);
    act(() => trigger()!.click());
    const menu = host.querySelector<HTMLDivElement>('[role="listbox"]')!;
    const key = (k: string) =>
      act(() => {
        menu.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
      });
    key("ArrowDown");
    key("Enter");
    expect(source.accounts.select).toHaveBeenCalledWith("claude-alt-2");
  });

  it("locks the choice once the session has run", () => {
    render(
      hostSource({
        selected: "claude-alt-2",
        lockedReason: "Start a new session to use another.",
      }),
    );
    expect(trigger()?.disabled).toBe(true);
    expect(trigger()?.title).toBe("Start a new session to use another.");
  });

  it("explains when an exhausted account is back", () => {
    expect(hostAccountStatus(ACCOUNTS[1], NOW)).toEqual({
      tone: "exhausted",
      label: "Exhausted",
      detail: "back in 30m",
    });
    expect(hostAccountStatus(ACCOUNTS[2], NOW).label).toBe("Idle");
  });
});
