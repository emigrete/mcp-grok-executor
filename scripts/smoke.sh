#!/usr/bin/env bash
# Smoke tests for mcp-grok-executor (no Claude required).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export MCP_GROK_SMOKE_ROOT="$ROOT"

echo "==> build"
npm run build

echo "==> unit tests"
npm test

echo "==> grok auth / hello"
if ! grok --no-auto-update -p "Say ok." >/tmp/mcp-grok-smoke-hello.txt 2>&1; then
  echo "FAIL: grok -p smoke failed. Run: grok login"
  cat /tmp/mcp-grok-smoke-hello.txt
  exit 1
fi
echo "    grok hello ok: $(head -c 80 /tmp/mcp-grok-smoke-hello.txt)"

echo "==> MCP tool list via short-lived client"
node --input-type=module <<'EOF'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";

const root = process.env.MCP_GROK_SMOKE_ROOT;
if (!root) throw new Error("MCP_GROK_SMOKE_ROOT not set");

const transport = new StdioClientTransport({
  command: "node",
  args: [resolve(root, "dist/index.js")],
});
const client = new Client({ name: "smoke", version: "0.0.1" });
await client.connect(transport);
const tools = await client.listTools();
const names = tools.tools.map((t) => t.name).sort();
console.log("    tools:", names.join(", "));
const expected = [
  "auth_status",
  "cancel_task",
  "continue_task",
  "execute_task",
  "review_task",
  "run_task",
  "task_status",
];
for (const e of expected) {
  if (!names.includes(e)) {
    console.error("MISSING tool:", e);
    process.exit(1);
  }
}
const auth = await client.callTool({ name: "auth_status", arguments: {} });
const text =
  Array.isArray(auth.content) && auth.content[0] && "text" in auth.content[0]
    ? auth.content[0].text
    : JSON.stringify(auth);
console.log("    auth_status:", String(text).slice(0, 200));
if (auth.isError) {
  console.error("auth_status reported error");
  process.exit(1);
}
await client.close();
console.log("    MCP listTools + auth_status ok");
EOF

echo "==> review_task (read-only, short)"
node --input-type=module <<'EOF'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";

const root = process.env.MCP_GROK_SMOKE_ROOT;
if (!root) throw new Error("MCP_GROK_SMOKE_ROOT not set");

const transport = new StdioClientTransport({
  command: "node",
  args: [resolve(root, "dist/index.js")],
});
const client = new Client({ name: "smoke-review", version: "0.0.1" });
await client.connect(transport);
const result = await client.callTool({
  name: "review_task",
  arguments: {
    prompt:
      "List the top-level files in this directory in one short bullet list. Do not modify anything.",
    cwd: root,
    timeout_sec: 180,
    max_turns: 8,
  },
});
const text =
  Array.isArray(result.content) && result.content[0] && "text" in result.content[0]
    ? result.content[0].text
    : JSON.stringify(result);
console.log(String(text).slice(0, 1500));
if (result.isError) {
  console.error("review_task failed");
  process.exit(1);
}
await client.close();
console.log("    review_task ok");
EOF

echo ""
echo "All smoke checks passed."
