import { expect, test, type Page } from "@playwright/test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The host account picker in the web desk. The fixture host has no account
// registry (its usage probes would need the network), so models.list is
// extended in the browser with three accounts in fixed states: Ready, Low and
// Exhausted. Saves 2x shots to output/p2-accounts/ and, when the Legend audit
// scripts are present (AUDIT_CHECKS), runs their checks on the picker only.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHOTS = join(ROOT, "output", "p2-accounts");
const APP = "/desk/ai/app/";
const HOUR = 3_600_000;

function accounts(now: number) {
  return [
    {
      id: "claude-main",
      label: "Claude (main)",
      harness: "claude",
      state: "ok",
      fiveHour: { usedPercent: 32, resetsAt: now + 3 * HOUR },
      weekly: { usedPercent: 14, resetsAt: now + 90 * HOUR },
      checkedAt: now,
    },
    {
      id: "claude-alt",
      label: "Claude (alt)",
      harness: "claude",
      state: "ok",
      fiveHour: { usedPercent: 86, resetsAt: now + 1.5 * HOUR },
      weekly: { usedPercent: 41, resetsAt: now + 60 * HOUR },
      checkedAt: now,
    },
    {
      id: "claude-alt-2",
      label: "Claude (alt-2)",
      harness: "claude",
      state: "exhausted",
      detail: "5-hour limit reached",
      fiveHour: { usedPercent: 100, resetsAt: now + 2 * HOUR },
      weekly: { usedPercent: 63, resetsAt: now + 30 * HOUR },
      checkedAt: now,
    },
  ];
}

async function withAccounts(page: Page) {
  await page.route("**/api/v1/desk-ai/host/rpc", async (route) => {
    const body = route.request().postDataJSON() as { method?: string };
    if (body?.method !== "models.list") return route.fallback();
    const response = await route.fetch();
    const json = await response.json();
    if (json?.result) json.result.accounts = accounts(Date.now());
    await route.fulfill({ response, json });
  });
}

const AUDIT_CHECKS =
  process.env.AUDIT_CHECKS ??
  "/Users/christopher/Desktop/trade/web/design/legend-style/audit_checks.cjs";

/** The Legend page checks, limited to the picker's trigger and menu. */
async function auditPicker(page: Page, width: number): Promise<string[]> {
  if (!existsSync(AUDIT_CHECKS)) return [];
  const checks = createRequire(import.meta.url)(AUDIT_CHECKS) as {
    SCALE: number[];
    pageChecks: (opts: unknown) => { errors: string[] };
  };
  const scope =
    "[data-host-account-picker] *, [data-host-account-picker], [data-host-account-picker-trigger], [data-host-account-picker-trigger] *";
  const source = checks.pageChecks
    .toString()
    .replaceAll("'body *'", JSON.stringify(scope));
  return page.evaluate(
    ({ source, opts }) =>
      // eslint-disable-next-line no-new-func
      (new Function(`return (${source})`)() as (o: unknown) => { errors: string[] })(opts)
        .errors,
    { source, opts: { scale: checks.SCALE, components: {}, width } },
  );
}

test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));

for (const width of [1440, 390, 320]) {
  test(`account picker at ${width} px`, async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width, height: width > 500 ? 900 : 844 },
      deviceScaleFactor: 2,
      ...(width < 500 ? { isMobile: true, hasTouch: true } : {}),
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await withAccounts(page);
    await page.goto(APP);
    await expect(page.locator("[data-composer-box] textarea")).toBeVisible();
    const trigger = page.locator("[data-host-account-picker-trigger]");
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-label", "Account: Default login");
    await page.screenshot({ path: join(SHOTS, `composer-${width}.png`) });

    await trigger.click();
    const menu = page.locator("[data-host-account-picker]");
    await expect(menu).toBeVisible();
    const options = menu.getByRole("option");
    await expect(options).toHaveCount(4);
    await expect(options.nth(1)).toContainText("Ready");
    await expect(options.nth(2)).toContainText("Low");
    await expect(options.nth(3)).toContainText("Exhausted");
    await expect(options.nth(3)).toHaveAttribute("aria-disabled", "true");
    // The menu fits the viewport.
    const box = await menu.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: join(SHOTS, `picker-open-${width}.png`) });
    await menu.screenshot({ path: join(SHOTS, `picker-menu-${width}.png`) });

    const findings = await auditPicker(page, width);
    writeFileSync(
      join(SHOTS, `audit-${width}.json`),
      JSON.stringify(findings, null, 2),
    );

    await options.nth(2).click();
    await expect(trigger).toHaveAttribute("aria-label", "Account: Claude (alt)");
    expect(errors).toEqual([]);
    await context.close();
  });
}
