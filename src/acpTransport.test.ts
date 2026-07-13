import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("acpRun maps session/update to thought/text/tool/end events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mgx-acp-"));
  await writeFile(join(dir, "auth.json"), "{}", "utf8");
  process.env.GROK_BIN = join(process.cwd(), "scripts", "fake-grok.mjs");
  process.env.GROK_AUTH_PATH = join(dir, "auth.json");
  process.env.MCP_GROK_CACHE_DIR = join(dir, "cache");
  delete process.env.FAKE_GROK_MODE;

  const { acpTransport } = await import("./acpTransport.js");
  const kinds: string[] = [];
  const tools: Array<{ name: string; status: string; detail?: string }> = [];
  const result = await acpTransport.run({
    prompt: "irrelevant",
    cwd: dir,
    mode: "execute",
    onEvent: (ev) => {
      kinds.push(ev.kind);
      if (ev.kind === "tool") {
        tools.push({ name: ev.name, status: ev.status, detail: ev.detail });
      }
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.summary, "All done.");
  assert.equal(result.sessionId, "acp-session-fixture");
  assert.deepEqual(result.usage, { numTurns: 2, totalTokens: 321 });
  assert.ok(kinds.includes("thought"));
  assert.ok(kinds.includes("text"));
  assert.ok(kinds.includes("end"));
  assert.equal(tools.length, 2);
  assert.equal(tools[0]!.status, "started");
  assert.equal(tools[1]!.status, "completed");
  assert.ok(kinds.filter((k) => k === "tool").length === 2);
});
