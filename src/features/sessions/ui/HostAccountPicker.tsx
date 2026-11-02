import {
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Check, ChevronDown, Gauge } from "../../../shared/ui/icons";
import { Popover } from "../../../shared/ui/Popover";
import { HARNESS_TITLE, type HarnessId } from "../model/session";
import { useModelSource } from "./modelSource";
import type {
  HostAccount,
  HostAccountWindow,
} from "../../connections/model/protocol";
import type { AccountStatus } from "../../providers/model/accountUsage";
import {
  formatResetDuration,
  type RateLimitWindow,
} from "../../providers/model/rateLimits";
import {
  AccountStatusLabel,
  UsageMeter,
} from "../../providers/ui/ProviderAccountUsage";

const MENU_WIDTH = 320;

type Row = {
  /** Undefined is the host's default login. */
  id: string | undefined;
  label: string;
  account?: HostAccount;
  disabledReason?: string;
};

const meterWindow = (
  window: HostAccountWindow | undefined,
  windowMinutes: number,
): RateLimitWindow | null =>
  window
    ? {
        usedPercent: window.usedPercent,
        windowMinutes,
        resetsAt: window.resetsAt ?? null,
      }
    : null;

/** Status line for one host account, in the words the usage page uses. */
export function hostAccountStatus(
  account: HostAccount,
  now: number,
): AccountStatus {
  if (account.state === "exhausted") {
    const blocking = [account.weekly, account.fiveHour].find(
      (window) => window && window.usedPercent >= 100,
    );
    return {
      tone: "exhausted",
      label: "Exhausted",
      detail: blocking?.resetsAt
        ? `back in ${formatResetDuration(blocking.resetsAt - now)}`
        : (account.detail ?? null),
    };
  }
  if (account.state === "idle")
    return {
      tone: "unknown",
      label: "Idle",
      detail: account.detail ?? "Refreshes on next use",
    };
  if (account.state === "disconnected")
    return { tone: "unknown", label: account.detail ?? "Not signed in", detail: null };
  if (account.state === "unknown")
    return { tone: "unknown", label: account.detail ?? "Usage unknown", detail: null };
  const used = Math.max(
    account.fiveHour?.usedPercent ?? 0,
    account.weekly?.usedPercent ?? 0,
  );
  return used >= 80
    ? { tone: "low", label: "Low", detail: null }
    : { tone: "ready", label: "Ready", detail: null };
}

/** Why an account cannot be chosen for a new turn, if it cannot. */
export function hostAccountUnavailable(account: HostAccount): string | undefined {
  if (account.state === "exhausted")
    return account.detail ?? "Usage limit reached";
  if (account.state === "disconnected")
    return account.detail ?? "Not signed in on the host";
  return undefined;
}

/**
 * Chooses which of the host's logins a session runs on. Renders nothing
 * unless the session's model source reports host accounts for its harness,
 * so local sessions and hosts without an account registry are unchanged.
 */
export function HostAccountPicker({
  harness,
  side = "top",
  onClose,
}: {
  harness: HarnessId;
  side?: "top" | "bottom";
  onClose?: () => void;
}) {
  const source = useModelSource();
  const accounts = source.accounts;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const root = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const own = (accounts?.list ?? []).filter(
    (account) => account.harness === harness,
  );
  const rows: Row[] = [
    { id: undefined, label: "Default login" },
    ...own.map((account) => ({
      id: account.id,
      label: account.label,
      account,
      disabledReason: hostAccountUnavailable(account),
    })),
  ];
  const selectedIndex = Math.max(
    0,
    rows.findIndex((row) => row.id === accounts?.selected),
  );
  const selected = rows[selectedIndex];

  if (!accounts || own.length === 0) return null;

  const show = () => {
    setNow(Date.now());
    setActive(selectedIndex);
    setOpen(true);
    // Usage ages; each opening asks the host again (it caches for 5 minutes).
    source.refresh([harness]);
  };
  const dismiss = (restore: boolean) => {
    setOpen(false);
    if (restore) onCloseRef.current?.();
  };
  const pick = (row: Row) => {
    if (row.disabledReason) return;
    accounts.select(row.id);
    dismiss(true);
  };
  const step = (direction: 1 | -1) => {
    setActive((index) => {
      for (let n = 1; n <= rows.length; n++) {
        const next = (index + direction * n + rows.length) % rows.length;
        if (!rows[next].disabledReason) return next;
      }
      return index;
    });
  };
  const onMenuKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      step(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const row = rows[active];
      if (row) pick(row);
    }
  };

  const locked = accounts.lockedReason;

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        data-host-account-picker-trigger
        disabled={!!locked}
        title={locked ?? `Account: ${selected.label}`}
        aria-label={`Account: ${selected.label}`}
        aria-expanded={open}
        aria-haspopup="listbox"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => (open ? dismiss(true) : show())}
        className={`flex h-6.5 max-w-52 items-center gap-1 rounded-md bg-selection px-1.5 text-content ${
          locked ? "opacity-60" : open ? "" : "hover:bg-selection-hover"
        }`}
      >
        <Gauge className="size-3.5 shrink-0" strokeWidth={1.75} />
        {/* Phones keep the icon; the label would push Access off the row. */}
        <span className="hidden min-w-0 truncate text-[11px] sm:inline">
          {selected.label}
        </span>
        {locked ? null : (
          <ChevronDown
            className={`hidden size-3 shrink-0 text-content/50 sm:block ${open ? "rotate-180" : ""}`}
            strokeWidth={1.75}
          />
        )}
      </button>
      {open ? (
        <Popover
          anchor={root}
          side={side}
          width={MENU_WIDTH}
          maxHeight={360}
          autoFocus
          onDismiss={(reason) => dismiss(reason === "escape")}
          ignore="[data-host-account-picker-trigger]"
          role="listbox"
          aria-label={`${HARNESS_TITLE[harness]} account`}
          aria-activedescendant={`${menuId}-${active}`}
          data-host-account-picker
          tabIndex={-1}
          onKeyDown={onMenuKey}
          className="overflow-y-auto overscroll-contain p-1 font-sans text-content"
        >
          <div className="px-2 pb-1 pt-1.5 text-[11px] text-content/60">
            {HARNESS_TITLE[harness]} accounts
          </div>
          {rows.map((row, index) => {
            const rowStatus = row.account
              ? hostAccountStatus(row.account, now)
              : undefined;
            const five = meterWindow(row.account?.fiveHour, 300);
            const weekly = meterWindow(row.account?.weekly, 10_080);
            const isSelected = index === selectedIndex;
            return (
              <button
                key={row.id ?? "default"}
                id={`${menuId}-${index}`}
                type="button"
                role="option"
                aria-selected={isSelected}
                aria-disabled={row.disabledReason ? true : undefined}
                tabIndex={-1}
                title={row.disabledReason}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => {
                  if (!row.disabledReason) setActive(index);
                }}
                onClick={() => pick(row)}
                className={`flex w-full flex-col gap-1.5 rounded-lg px-2 py-2 text-left ${
                  row.disabledReason
                    ? "cursor-default opacity-50"
                    : index === active
                      ? "bg-selection"
                      : "hover:bg-content/5"
                }`}
              >
                <span className="flex w-full min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px]">
                    {row.label}
                  </span>
                  {rowStatus ? (
                    <AccountStatusLabel
                      status={rowStatus}
                      className="max-w-40 text-[11px]"
                    />
                  ) : (
                    <span className="shrink-0 text-[11px] text-content/60">
                      Host’s own login
                    </span>
                  )}
                  {isSelected ? (
                    <Check
                      className="size-3.5 shrink-0 text-content/70"
                      strokeWidth={1.75}
                    />
                  ) : null}
                </span>
                {five || weekly ? (
                  <span className="flex w-full gap-3">
                    {five ? (
                      <UsageMeter title="5h" window={five} now={now} className="min-w-0 flex-1" />
                    ) : null}
                    {weekly ? (
                      <UsageMeter title="Weekly" window={weekly} now={now} className="min-w-0 flex-1" />
                    ) : null}
                  </span>
                ) : null}
              </button>
            );
          })}
        </Popover>
      ) : null}
    </div>
  );
}
