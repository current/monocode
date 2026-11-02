#!/usr/bin/env node
// A fake `claude` CLI for the web desk smoke test, adapted from the host's
// provider transport fixture (host/provider-transport.test.ts). It speaks the
// stream-json control protocol and answers each turn with one tool call and
// a short markdown reply, without contacting any model.
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const session = "fixture-claude";
if (process.argv.includes("--no-session-persistence") && !process.argv.includes("--session-id"))
  send({ type: "system", subtype: "init", session_id: session });
let turn = 0;

function delegate(request) {
  const content = request.message?.content;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content) ? content.map((part) => part.text ?? "").join("") : "";
  // A worker turn that starts with FIXTURE_HOLD stays working until stopped. Only
  // at the start: the host's title prompt quotes the message after a preamble
  // and runs on one shared process, which a hold there would block.
  if (text.startsWith("FIXTURE_HOLD")) return true;
  if (!text.includes("FIXTURE_DELEGATE")) return false;
  // FIXTURE_DELEGATE_HOLD keeps the second worker working (sidebar shots).
  const hold = text.includes("FIXTURE_DELEGATE_HOLD");
  let reply;
  if (!process.env.MONOCODE) reply = "No app access in this session.";
  else {
    const { execFileSync } = require("node:child_process");
    const ids = [1, 2].map((n) =>
      JSON.parse(
        execFileSync(process.env.MONOCODE, [
          "app",
          "sessions.start",
          "--json",
          JSON.stringify({
            prompt: `${hold && n === 2 ? "FIXTURE_HOLD " : ""}Fixture worker ${n}`,
            title: n === 1 ? "Review the pricing tests" : "Port the sidebar marks",
          }),
        ], { encoding: "utf8" }),
      ).sessionId,
    );
    reply = `Started ${ids.join(" and ")}.`;
  }
  send({
    type: "assistant",
    session_id: session,
    message: { id: `msg_${turn + 1}_d`, role: "assistant", content: [{ type: "text", text: reply }] },
  });
  send({ type: "result", subtype: "success", session_id: session, result: "done" });
  return true;
}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.type === "control_request" && request.request?.subtype === "initialize") {
    send({ type: "system", subtype: "init", session_id: session });
    send({ type: "control_response", response: { subtype: "success", request_id: request.request_id } });
  } else if (request.type === "control_request" && request.request?.subtype === "list_models") {
    send({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: request.request_id,
        response: {
          models: [
            { value: "claude-fixture-model", resolvedModel: "claude-fixture-model", displayName: "Fixture Claude" },
          ],
        },
      },
    });
  } else if (request.type === "control_request") {
    send({ type: "control_response", response: { subtype: "success", request_id: request.request_id } });
  } else if (request.type === "user" && delegate(request)) {
    // Operator end-to-end test: a lead starts two workers through the
    // host's app CLI, then ends its turn (host/operator-e2e.test.ts).
    ++turn;
  } else if (request.type === "user") {
    const id = `toolu_fixture_${++turn}`;
    setTimeout(() => {
      send({
        type: "assistant",
        session_id: session,
        message: { id: `msg_${turn}_a`, role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command: "ls", description: "List files" } }] },
      });
    }, 150);
    setTimeout(() => {
      send({
        type: "user",
        session_id: session,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "README.md\nsrc" }] },
      });
    }, 400);
    setTimeout(() => {
      send({
        type: "assistant",
        session_id: session,
        message: {
          id: `msg_${turn}_b`,
          role: "assistant",
          content: [{ type: "text", text: "Fixture reply: the desk has **two** entries.\n\n- `README.md`\n- `src`" }],
        },
      });
      send({ type: "result", subtype: "success", session_id: session, result: "done" });
    }, 700);
  }
});
