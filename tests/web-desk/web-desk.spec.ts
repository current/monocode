import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SHOTS = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "output",
  "web-desk",
);
const APP = "/desk/ai/app/";

/** Same-origin only, and the page never carries a credential header. */
function watchRequests(page: Page, origin: string) {
  const offenders: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    if (!url.startsWith(origin)) offenders.push(`cross-origin ${url}`);
    if (request.headers().authorization) offenders.push(`authorization on ${url}`);
  });
  return offenders;
}

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  return errors;
}

test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));

test("boots into the desk project, sends a prompt and renders the reply", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  const offenders = watchRequests(page, baseURL!);
  const errors = watchErrors(page);
  await page.goto(APP);

  // The desk host's checkout is the open project, with its sessions sidebar.
  await expect(page.getByRole("button", { name: "Current project desk-project" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Sessions" })).toBeVisible();
  const composer = page.locator("[data-composer-box] textarea");
  await expect(composer).toBeVisible();
  // The model picker lists the host's models; only the fake Claude has any.
  await expect(page.getByRole("button", { name: /Fixture Claude/ })).toBeVisible();
  await expect(page.locator("html")).toHaveClass(/web-desk/);

  // Local-only features are hidden.
  for (const name of ["Settings", "Inbox", "Automations", "Notes", "Search", "Toggle Projects"])
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Projects" })).toHaveCount(0);
  await expect(page.getByText("Meet Monos")).toHaveCount(0);

  await composer.click();
  await composer.fill("List the desk files");
  await composer.press("Enter");

  // The user turn, the fake provider's tool call and its markdown reply.
  await expect(page.getByText("List the desk files").first()).toBeVisible();
  // Markdown: the bold word loses its asterisks, the list items are code.
  await expect(
    page.getByRole("paragraph").filter({
      hasText: "Fixture reply: the desk has two entries.",
    }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("li code", { hasText: "README.md" })).toBeVisible();
  const worked = page.getByText(/worked for/).first();
  await expect(worked).toBeVisible({ timeout: 15_000 });
  await worked.click();
  await expect(page.getByText("ls", { exact: true }).first()).toBeVisible();

  // The new session is listed in the sidebar from the host.
  await expect(
    page.getByRole("button", { name: /^Archive Fixture reply/ }),
  ).toHaveCount(1, { timeout: 15_000 });

  await page.screenshot({ path: join(SHOTS, "web-desk-1440.png") });
  expect(errors).toEqual([]);
  expect(offenders).toEqual([]);
  await context.close();
});

test("fits a phone width with the session list behind its toggle", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const offenders = watchRequests(page, baseURL!);
  const errors = watchErrors(page);
  await page.goto(APP);
  const composer = page.locator("[data-composer-box] textarea");
  await expect(composer).toBeVisible();
  await expect(page.getByRole("button", { name: /Fixture Claude/ })).toBeVisible();
  // The composer fits inside the viewport.
  const box = await page.locator("[data-composer-box]").boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: join(SHOTS, "web-desk-390.png") });
  expect(errors).toEqual([]);
  expect(offenders).toEqual([]);
  await context.close();
});

test("shows a retryable error when the bridge refuses", async ({ page }) => {
  await page.route("**/api/v1/desk-ai/host/info", (route) =>
    route.fulfill({ status: 401, json: { error: "Sign in to the desk." } }),
  );
  await page.goto(APP);
  await expect(page.getByRole("alert")).toContainText("Sign in to the desk.");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});
