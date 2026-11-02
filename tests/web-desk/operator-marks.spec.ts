import { expect, test, type Page, type APIRequestContext } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// UI gate for the sidebar's operator marks: a lead with two agents (one
// working, one finished) on the fixture host, shot at 2x on desktop and phone
// widths and under reduced motion, with a bounding-box audit of the rows.
const SHOTS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "output", "p2-operator");
const APP = "/desk/ai/app/";
const RPC = "/api/v1/desk-ai/host/rpc";
const LEAD_TITLE = "Plan the operator rollout";

async function rpc(request: APIRequestContext, method: string, params: Record<string, unknown> = {}) {
  const response = await request.post(RPC, { data: { method, params } });
  const body = (await response.json()) as { result?: any; error?: string };
  if (body.error) throw new Error(`${method}: ${body.error}`);
  return body.result;
}

type Sessions = Array<{ id: string; title: string; status: string; runId?: string }>;
let lead: { id: string; projectId: string } | undefined;

/** One lead per fixture host; later tests reuse it. */
async function ensureLead(request: APIRequestContext) {
  if (lead) return lead;
  const info = (await (await request.get("/api/v1/desk-ai/host/info")).json()) as { projectPath: string };
  const project = (await rpc(request, "projects.open", { cwd: info.projectPath })) as { id: string };
  const { sessionId } = await rpc(request, "commands.dispatch", {
    type: "create",
    commandId: "marks-lead",
    projectId: project.id,
    harness: "claude",
    model: "claude:claude-fixture-model",
    runtimeMode: "supervised",
  });
  await rpc(request, "commands.dispatch", {
    type: "send",
    commandId: "marks-lead-send",
    sessionId,
    text: "/operator FIXTURE_DELEGATE_HOLD start two workers",
  });
  await expect
    .poll(
      async () => {
        const sessions = (await rpc(request, "sessions.list", { projectId: project.id })) as Sessions;
        const workers = sessions.filter((s) => s.id.startsWith(`app-${sessionId}-`));
        const leadRow = sessions.find((s) => s.id === sessionId);
        return (
          workers.length === 2 &&
          workers.filter((s) => s.status === "running").length === 1 &&
          leadRow?.status === "idle"
        );
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  await rpc(request, "sessions.update", { projectId: project.id, sessionId, title: LEAD_TITLE });
  lead = { id: sessionId, projectId: project.id };
  return lead;
}

/** Bounding-box checks on the marked rows (adapted from the Legend audit_checks.cjs). */
function auditRows(page: Page, leadId: string) {
  return page.evaluate((leadId) => {
    const SCALE = [0, 1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48];
    const onScale = (v: number) => SCALE.some((s) => Math.abs(Math.abs(v) - s) < 0.26);
    const errors: string[] = [];
    const metrics: Record<string, unknown> = {};
    const box = (e: Element) => e.getBoundingClientRect();
    const px = (v: string) => parseFloat(v) || 0;
    const rows = [...document.querySelectorAll<HTMLElement>("[data-session-card]")];
    const leadCard = rows.find((r) => r.dataset.sessionCard === leadId);
    const agents = rows.filter((r) => r.dataset.sessionCard?.startsWith(`app-${leadId}-`));
    if (!leadCard) errors.push("lead row missing");
    if (agents.length !== 2) errors.push(`agent rows ${agents.length}`);
    if (leadCard) {
      const card = box(leadCard);
      const tint = leadCard.querySelector("[data-lead-tint]");
      if (!tint) errors.push("lead tint missing");
      else {
        const t = box(tint);
        const s = getComputedStyle(leadCard);
        const inner = {
          left: card.left + px(s.borderLeftWidth),
          right: card.right - px(s.borderRightWidth),
          top: card.top + px(s.borderTopWidth),
          bottom: card.bottom - px(s.borderBottomWidth),
        };
        for (const k of ["left", "right", "top", "bottom"] as const)
          if (Math.abs(t[k] - inner[k]) > 0.5) errors.push(`tint ${k} off card by ${(t[k] - inner[k]).toFixed(2)}`);
        if (getComputedStyle(tint).borderTopLeftRadius !== s.borderTopLeftRadius)
          errors.push(`tint radius ${getComputedStyle(tint).borderTopLeftRadius} != card ${s.borderTopLeftRadius}`);
        const edge = tint.firstElementChild!;
        const e = box(edge);
        if (Math.abs(e.top - t.top - 4) > 0.5 || Math.abs(t.bottom - e.bottom - 4) > 0.5)
          errors.push("lead edge not inset 4px top and bottom");
        if (Math.abs(e.left - t.left) > 0.5) errors.push("lead edge not on the row's left edge");
        metrics.lead = { card: [card.width, card.height], edge: [e.width, e.height] };
      }
      // A lead whose agents all work or wait: the sheen shows only while one works.
      metrics.sheen = !!leadCard.querySelector("[data-lead-sheen]");
    }
    const workerTitles: number[] = [];
    for (const row of agents) {
      const mark = row.querySelector<HTMLElement>("[data-agent-of]");
      if (!mark) {
        errors.push(`agent mark missing on ${row.dataset.sessionCard}`);
        continue;
      }
      const m = box(mark);
      const line = mark.parentElement!;
      const lineBox = box(line);
      const title = line.querySelector<HTMLElement>("[class*='line-clamp-1']");
      // Mark centred on the title's line, within half a pixel.
      if (Math.abs(m.top + m.height / 2 - (lineBox.top + lineBox.height / 2)) > 0.5)
        errors.push(`agent mark off line centre ${(m.top + m.height / 2 - (lineBox.top + lineBox.height / 2)).toFixed(2)}`);
      if (title) workerTitles.push(box(title).left);
      const ms = getComputedStyle(mark);
      for (const k of ["paddingLeft", "paddingRight", "columnGap"] as const)
        if (!onScale(px(ms[k]))) errors.push(`agent mark ${k} off scale ${ms[k]}`);
      // Optical alignment: the glyph ends on the content edge, so only the
      // mark's own hover padding may overhang the row's content box.
      const rs = getComputedStyle(row);
      if (m.right > box(row).right - px(rs.paddingRight) + px(ms.paddingRight) + 0.5)
        errors.push("agent mark overhangs the row padding by more than its own padding");
      // Hit target: real hit testing at +/-12px around the centre (dense rows allow 24px).
      const cx = m.left + m.width / 2;
      const cy = m.top + m.height / 2;
      const miss = [
        [cx, cy],
        [cx - 11.5, cy],
        [cx + 11.5, cy],
        [cx, cy - 11.5],
        [cx, cy + 11.5],
      ].filter(([x, y]) => {
        const hit = document.elementFromPoint(x, y);
        return !(hit && (hit === mark || mark.contains(hit)));
      });
      if (miss.length) errors.push(`agent mark hit target < 24px (${m.width.toFixed(0)}x${m.height.toFixed(0)})`);
      const dot = mark.lastElementChild!;
      const status = row.querySelector<HTMLElement>("[class*='tabular-nums']");
      const contentRight = box(row).right - px(rs.paddingRight) - px(rs.borderRightWidth);
      if (Math.abs(box(dot).right - contentRight) > 0.5)
        errors.push(`agent mark glyph ${(contentRight - box(dot).right).toFixed(2)}px short of the row's trailing edge`);
      if (status && Math.abs(box(status).right - contentRight) > 0.5) metrics.statusRight = box(status).right - contentRight;
      metrics.mark = [m.width, m.height];
      metrics.markLabel = mark.getAttribute("aria-label");
    }
    if (workerTitles.length === 2 && Math.abs(workerTitles[0] - workerTitles[1]) > 0.5)
      errors.push("agent titles not left-aligned with each other");
    return { errors, metrics };
  }, leadId);
}

async function contrast(page: Page) {
  // Glyph contrast of the agent mark against its row (3:1), and of the edge.
  return page.evaluate(() => {
    const parse = (c: string) => {
      if (!c || c === "transparent" || c === "rgba(0, 0, 0, 0)") return [0, 0, 0, 0];
      const canvas = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
      canvas.fillStyle = "#000";
      canvas.fillStyle = c;
      canvas.fillRect(0, 0, 1, 1);
      const d = canvas.getImageData(0, 0, 1, 1).data;
      return [d[0] / 255, d[1] / 255, d[2] / 255, d[3] / 255];
    };
    const over = (fg: number[], bg: number[]) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);
    const lum = (c: number[]) =>
      c.slice(0, 3).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((n, v, i) => n + v * [0.2126, 0.7152, 0.0722][i], 0);
    const ratio = (a: number[], b: number[]) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    const bgOf = (e: Element) => {
      const stack: number[][] = [];
      for (let a: Element | null = e; a; a = a.parentElement) {
        const c = parse(getComputedStyle(a).backgroundColor);
        if (c[3] > 0) stack.push(c);
        if (c[3] >= 1) break;
      }
      let base = parse(getComputedStyle(document.body).backgroundColor);
      if (base[3] === 0) base = [1, 1, 1, 1];
      for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i], base);
      return base;
    };
    const out: Record<string, number> = {};
    const mark = document.querySelector("[data-agent-of]");
    if (mark) out.mark = ratio(over(parse(getComputedStyle(mark).color), bgOf(mark)), bgOf(mark));
    const edge = document.querySelector("[data-lead-tint] > span");
    if (edge) {
      const card = edge.closest("[data-session-card]")!;
      out.edge = ratio(over(parse(getComputedStyle(edge).backgroundColor), bgOf(card)), bgOf(card));
    }
    return out;
  });
}

async function sidebarClip(page: Page, leadId: string) {
  const ids = await page.locator(`[data-session-card^="app-${leadId}-"], [data-session-card="${leadId}"]`).all();
  const boxes = (await Promise.all(ids.map((l) => l.boundingBox()))).filter((b) => b !== null);
  const left = Math.max(0, Math.min(...boxes.map((b) => b.x)) - 12);
  const top = Math.max(0, Math.min(...boxes.map((b) => b.y)) - 12);
  const right = Math.max(...boxes.map((b) => b.x + b.width)) + 12;
  const bottom = Math.max(...boxes.map((b) => b.y + b.height)) + 12;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));

// The fixture host is shared with the other specs: drop the lead and its
// agents (one still held working) so later sidebars start clean.
test.afterAll(async ({ playwright, baseURL }) => {
  if (!lead) return;
  const request = await playwright.request.newContext({ baseURL });
  const { projectId, id } = lead;
  const ours = async () =>
    ((await rpc(request, "sessions.list", { projectId })) as Sessions).filter(
      (s) => s.id === id || s.id.startsWith(`app-${id}-`),
    );
  for (const s of await ours())
    if (s.status === "running" && s.runId)
      await rpc(request, "commands.dispatch", { type: "cancel", commandId: `marks-stop-${s.id}`, sessionId: s.id, runId: s.runId });
  await expect.poll(async () => (await ours()).some((s) => s.status === "running"), { timeout: 15_000 }).toBe(false);
  for (const s of await ours()) await rpc(request, "sessions.delete", { projectId, sessionId: s.id });
  await request.dispose();
  lead = undefined;
});

const CASES = [
  { name: "1440", viewport: { width: 1440, height: 900 }, mobile: false, reduced: false },
  { name: "390", viewport: { width: 390, height: 844 }, mobile: true, reduced: false },
  { name: "1440-reduced-motion", viewport: { width: 1440, height: 900 }, mobile: false, reduced: true },
] as const;

for (const shot of CASES) {
  test(`operator lead and agent marks in the sidebar (${shot.name})`, async ({ browser }) => {
    const context = await browser.newContext({
      viewport: shot.viewport,
      deviceScaleFactor: 2,
      ...(shot.mobile ? { isMobile: true, hasTouch: true } : {}),
      reducedMotion: shot.reduced ? "reduce" : "no-preference",
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    const { id } = await ensureLead(context.request);
    await page.goto(APP);
    await expect(page.locator("[data-composer-box] textarea")).toBeVisible();
    if (shot.mobile) await page.getByRole("button", { name: /Toggle (Session )?Sidebar/ }).first().click();
    const leadRow = page.locator(`[data-session-card="${id}"]`);
    await expect(leadRow).toBeVisible({ timeout: 15_000 });
    await expect(leadRow.locator("[data-lead-tint]")).toBeVisible();
    await expect(page.getByRole("button", { name: `Agent of ${LEAD_TITLE}`, exact: true })).toHaveCount(2);
    // Working agent: the sheen runs, unless motion is reduced (then hidden).
    const sheen = leadRow.locator("[data-lead-sheen]");
    await expect(sheen).toHaveCount(1);
    if (shot.reduced) await expect(sheen).toBeHidden();
    else await expect(sheen).toBeVisible();
    // Freeze the sheen mid-row so the still shows it.
    await page.evaluate(() =>
      document.getAnimations().forEach((a) => {
        if ((a as CSSAnimation).animationName === "sidebar-lead-sweep") {
          a.pause();
          a.currentTime = 700;
        }
      }),
    );
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(SHOTS, `sidebar-${shot.name}.png`) });
    await page.screenshot({ path: join(SHOTS, `sidebar-${shot.name}-rows.png`), clip: await sidebarClip(page, id) });
    const audit = await auditRows(page, id);
    const ratios = await contrast(page);
    if (ratios.mark !== undefined && ratios.mark < 3) audit.errors.push(`agent mark contrast ${ratios.mark.toFixed(2)} < 3`);
    writeFileSync(join(SHOTS, `audit-${shot.name}.json`), JSON.stringify({ ...audit, contrast: ratios }, null, 2));
    // Clicking an agent's mark opens its lead.
    await page.getByRole("button", { name: `Agent of ${LEAD_TITLE}`, exact: true }).first().click();
    await expect(page.locator(`[data-session-card="${id}"] [aria-current="true"]`)).toHaveCount(1);
    expect(audit.errors).toEqual([]);
    expect(errors).toEqual([]);
    await context.close();
  });
}
