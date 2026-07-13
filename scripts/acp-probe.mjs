#!/usr/bin/env node
// ACP spike: talk JSON-RPC 2.0 to `grok agent stdio`, run one prompt that
// forces a tool call, auto-approve permissions, and dump every message shape.
// Usage: node scripts/acp-probe.mjs <demo-cwd> [outfile]
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const DEMO = process.argv[2];
const OUT = process.argv[3] ?? "/tmp/acp-probe.log";
if (!DEMO) {
  console.error("usage: acp-probe.mjs <demo-cwd> [outfile]");
  process.exit(1);
}

const GROK = process.env.GROK_BIN ?? "grok";
const child = spawn(GROK, ["agent", "stdio"], {
  cwd: DEMO,
  stdio: ["pipe", "pipe", "pipe"],
});

const transcript = [];
let nextId = 1;
const pending = new Map(); // id -> {resolve}

function send(obj) {
  transcript.push({ dir: "OUT", msg: obj });
  child.stdin.write(JSON.stringify(obj) + "\n");
}
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}
function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

const seenUpdates = new Map(); // sessionUpdate kind -> first example
let buf = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      transcript.push({ dir: "IN-RAW", line });
      continue;
    }
    transcript.push({ dir: "IN", msg });
    handle(msg);
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (d) => transcript.push({ dir: "ERR", text: d }));

function handle(msg) {
  // Response to one of our requests
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
    return;
  }
  // Notification
  if (msg.method === "session/update") {
    const kind = msg.params?.update?.sessionUpdate ?? "(unknown)";
    if (!seenUpdates.has(kind)) seenUpdates.set(kind, msg.params.update);
    return;
  }
  // Incoming request from the agent (e.g. permission)
  if (msg.method && msg.id !== undefined) {
    if (msg.method === "session/request_permission") {
      const options = msg.params?.options ?? [];
      const allow =
        options.find((o) => /allow/i.test(o.optionId ?? "") || /allow/i.test(o.name ?? "")) ??
        options[0];
      console.log(`  ← request_permission → answering with ${allow?.optionId}`);
      respond(msg.id, { outcome: { outcome: "selected", optionId: allow?.optionId } });
    } else if (msg.method === "fs/read_text_file" || msg.method === "fs/write_text_file") {
      // We did not advertise fs caps; answer with an error to see behavior.
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not supported" } });
    } else {
      console.log(`  ← unhandled agent request: ${msg.method}`);
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unhandled" } });
    }
  }
}

const deadline = setTimeout(() => {
  console.log("TIMEOUT — killing agent");
  finish(1);
}, 120_000);

function finish(code) {
  clearTimeout(deadline);
  try {
    child.kill("SIGTERM");
  } catch {}
  writeFileSync(OUT, JSON.stringify(transcript, null, 2));
  console.log(`\ntranscript: ${OUT} (${transcript.length} messages)`);
  console.log("update kinds seen:");
  for (const [k, v] of seenUpdates) {
    console.log(`  · ${k}: ${JSON.stringify(v).slice(0, 220)}`);
  }
  process.exit(code);
}

// ---- flow ----
console.log("1) initialize");
const init = await request("initialize", {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
});
console.log("   agent:", JSON.stringify(init.result).slice(0, 300));

console.log("2) session/new");
const sess = await request("session/new", { cwd: DEMO, mcpServers: [] });
console.log("   session:", JSON.stringify(sess.result).slice(0, 200));
const sessionId = sess.result?.sessionId;
if (!sessionId) {
  console.log("NO SESSION — aborting", JSON.stringify(sess));
  finish(1);
}

console.log("3) session/prompt (forces a write tool call)");
const turn = await request("session/prompt", {
  sessionId,
  prompt: [
    {
      type: "text",
      text: "Create a file named probe.txt containing exactly 'hello acp'. Then say done.",
    },
  ],
});
console.log("   stopReason:", JSON.stringify(turn.result));
finish(0);
