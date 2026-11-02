// End to end through the built host (`npm run host:build`, run by
// pretest:host) and the web desk's fixture: a fake `claude` lead starts two
// workers with the host's app CLI and receives exactly one report.
import { afterAll, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

type FixtureHost = {
  url: string;
  token: string;
  projectPath: string;
  log: () => string;
  stop: () => Promise<void>;
};
const fixture = fileURLToPath(new URL("../scripts/web-desk/fixture-host.mjs", import.meta.url));
const { startFixtureHost } = (await import(fixture)) as {
  startFixtureHost: (options: { port: number }) => Promise<FixtureHost>;
};

let host: FixtureHost | undefined;
afterAll(async () => {
  await host?.stop();
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it.skipIf(process.platform === "win32")(
  "a lead starts two workers and receives one report",
  async () => {
    host = await startFixtureHost({ port: 3790 + Math.floor(Math.random() * 400) });
    let environmentId: string | undefined;
    const rpc = async (method: string, params: Record<string, unknown> = {}) => {
      const response = await fetch(`${host!.url}/rpc`, {
        method: "POST",
        headers: { Authorization: `Bearer ${host!.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ version: 1, method, params, environmentId }),
      });
      const body = (await response.json()) as { result?: any; error?: string };
      if (body.error) throw new Error(`${method}: ${body.error}\n${host!.log()}`);
      return body.result;
    };
    environmentId = (await rpc("environment.describe", { supportedProviders: ["claude"] })).environmentId;
    const project = await rpc("projects.open", { cwd: host.projectPath });
    // A device credential (and so the browser desk) never reaches app.* methods.
    await expect(rpc("app.sessions.list")).rejects.toThrow(/only available to operator sessions/);
    const { sessionId: leadId } = await rpc("commands.dispatch", {
      type: "create",
      commandId: "lead-create",
      projectId: project.id,
      harness: "claude",
      model: "claude:claude-fixture-model",
      runtimeMode: "supervised",
    });
    await rpc("commands.dispatch", {
      type: "send",
      commandId: "lead-send",
      sessionId: leadId,
      text: "/operator FIXTURE_DELEGATE start two workers",
    });

    const reports = async () =>
      ((await rpc("sessions.get", { sessionId: leadId })).session.blocks as Array<{ role: string; text: string }>)
        .filter((block) => block.role === "user" && block.text.startsWith("[Delegated work completed]"));
    const deadline = Date.now() + 30_000;
    let sessions: Array<{ id: string; status: string; title: string }> = [];
    while (Date.now() < deadline) {
      sessions = await rpc("sessions.list", { projectId: project.id });
      const lead = sessions.find((s) => s.id === leadId);
      if (sessions.length === 3 && sessions.every((s) => s.status !== "running") && (await reports()).length)
        if (lead?.status === "idle") break;
      await wait(200);
    }
    const workers = sessions.filter((s) => s.id !== leadId);
    expect(workers.map((s) => s.title).sort()).toEqual(["Worker 1", "Worker 2"]);
    for (const worker of workers) expect(worker.id.startsWith(`app-${leadId}-`)).toBe(true);
    // Give a duplicate report time to show up, if there were one.
    await wait(1_500);
    const delivered = await reports();
    expect(delivered).toHaveLength(1);
    expect(delivered[0].text).toContain("All sessions you started have stopped.");
    for (const worker of workers) {
      expect(delivered[0].text).toContain(`Session ${worker.id}: ${worker.title}\nFixture reply`);
    }
    const lead = await rpc("sessions.get", { sessionId: leadId });
    const first = lead.session.blocks.find((b: { role: string }) => b.role === "user");
    expect(first).toMatchObject({ text: "FIXTURE_DELEGATE start two workers", monocode: true });
    expect(
      lead.session.blocks.some((b: { role: string; text: string }) =>
        b.role === "assistant" && b.text.startsWith("Started app-"),
      ),
    ).toBe(true);
  },
  60_000,
);
