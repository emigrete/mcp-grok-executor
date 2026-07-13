import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Env must be set before the first import of config/grokRunner in this file
// (module cache persists within one test file).
process.env.MCP_GROK_TRANSPORT = "acp";

test("acp transport is not wired yet", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mgx-transport-"));
  await writeFile(join(dir, "auth.json"), "{}", "utf8");
  process.env.GROK_BIN = join(process.cwd(), "scripts", "fake-grok.mjs");
  process.env.GROK_AUTH_PATH = join(dir, "auth.json");
  process.env.MCP_GROK_CACHE_DIR = join(dir, "cache");
  delete process.env.FAKE_GROK_MODE;

  const { runGrok } = await import("./grokRunner.js");

  await assert.rejects(
    () =>
      runGrok({
        prompt: "x",
        cwd: "/tmp",
        mode: "execute",
      }),
    /not implemented/,
  );

  // review mode always uses CLI even when transport is acp
  const review = await runGrok({
    prompt: "x",
    cwd: dir,
    mode: "review",
  });
  assert.equal(review.ok, true);
});
