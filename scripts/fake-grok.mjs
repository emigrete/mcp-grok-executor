#!/usr/bin/env node
// Test double for the grok CLI: ignores args, emits a fixed streaming-json
// conversation on stdout, exits 0. Used by src/grokRunner.test.ts.
// FAKE_GROK_MODE=slow: emit thought, wait 5s, then the rest (for abort tests).
// FAKE_GROK_MODE=plain: print non-JSON stdout only (no NDJSON stream events).
// When argv includes "agent" (as in `grok agent stdio`), act as a fake ACP agent.
const events = [
  { type: "thought", data: "planning" },
  { type: "text", data: "All " },
  { type: "text", data: "done." },
  {
    type: "end",
    stopReason: "EndTurn",
    sessionId: "11111111-1111-4111-8111-111111111111",
    num_turns: 1,
    usage: { total_tokens: 42 },
  },
];

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function notifyUpdate(update) {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { update },
  });
}

function runAcpAgent() {
  process.stdin.setEncoding("utf8");
  let buf = "";
  process.stdin.on("data", (d) => {
    buf += d;
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      handleAcp(msg);
    }
  });
  // Keep process alive until stdin closes (or client kills us).
  process.stdin.on("end", () => process.exit(0));
}

function handleAcp(msg) {
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
      },
    });
    return;
  }
  if (msg.method === "session/new") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { sessionId: "acp-session-fixture" },
    });
    return;
  }
  if (msg.method === "session/load") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {},
    });
    return;
  }
  if (msg.method === "session/prompt") {
    notifyUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "thinking" },
    });
    notifyUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "All " },
    });
    notifyUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "done." },
    });
    notifyUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "write",
      rawInput: { file_path: "/tmp/x.txt", content: "hi" },
    });
    notifyUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      content: [{ type: "diff", path: "/tmp/x.txt" }],
    });
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        stopReason: "end_turn",
        _meta: { usage: { numTurns: 2, totalTokens: 321 } },
      },
    });
    return;
  }
  // Unhandled agent-side method from client — ignore or error if it has an id.
  if (msg.id !== undefined) {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: "unhandled" },
    });
  }
}

async function main() {
  if (process.argv.includes("agent")) {
    runAcpAgent();
    return;
  }

  if (process.env.FAKE_GROK_MODE === "plain") {
    process.stdout.write("Plain non-JSON output.\n");
    process.exit(0);
  }
  if (process.env.FAKE_GROK_MODE === "slow") {
    process.stdout.write(JSON.stringify(events[0]) + "\n");
    await new Promise((r) => setTimeout(r, 5000));
    for (const ev of events.slice(1)) {
      process.stdout.write(JSON.stringify(ev) + "\n");
    }
  } else {
    for (const ev of events) process.stdout.write(JSON.stringify(ev) + "\n");
  }
  process.exit(0);
}

main();
