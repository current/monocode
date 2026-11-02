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
