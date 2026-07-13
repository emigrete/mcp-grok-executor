import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("runGrok parses streaming output from fake grok", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mgx-runner-"));
  await writeFile(join(dir, "auth.json"), "{}", "utf8");
  process.env.GROK_BIN = join(process.cwd(), "scripts", "fake-grok.mjs");
  process.env.GROK_AUTH_PATH = join(dir, "auth.json");
  process.env.MCP_GROK_CACHE_DIR = join(dir, "cache");
  delete process.env.FAKE_GROK_MODE;

  const { runGrok } = await import("./grokRunner.js");
  const kinds: string[] = [];
  const result = await runGrok({
    prompt: "irrelevant",
    cwd: dir,
    mode: "execute",
    onEvent: (ev) => kinds.push(ev.kind),
  });

  assert.equal(result.ok, true);
  assert.equal(result.summary, "All done.");
  // sessionId must come from the end event, overriding the generated one:
  assert.equal(result.sessionId, "11111111-1111-4111-8111-111111111111");
  assert.deepEqual(result.usage, { numTurns: 1, totalTokens: 42 });
  assert.ok(kinds.includes("thought"));
  assert.ok(kinds.includes("text"));
  assert.ok(kinds.includes("end"));
});

test("abort kills a slow grok run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mgx-runner-abort-"));
  await writeFile(join(dir, "auth.json"), "{}", "utf8");
  process.env.GROK_BIN = join(process.cwd(), "scripts", "fake-grok.mjs");
  process.env.GROK_AUTH_PATH = join(dir, "auth.json");
  process.env.MCP_GROK_CACHE_DIR = join(dir, "cache");
  process.env.FAKE_GROK_MODE = "slow";

  try {
    const { runGrok } = await import("./grokRunner.js");
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const started = Date.now();
    const result = await runGrok({
      prompt: "irrelevant",
      cwd: dir,
      mode: "execute",
      signal: ac.signal,
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 3000, `expected <3s, took ${elapsed}ms`);
    assert.equal(result.ok, false);
  } finally {
    delete process.env.FAKE_GROK_MODE;
  }
});
