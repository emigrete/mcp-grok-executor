import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { runCommand } from "./shell.js";

test("captures exit code and merged stdout+stderr", async () => {
  const r = await runCommand("echo out; echo err >&2; exit 3", tmpdir(), 10);
  assert.equal(r.exitCode, 3);
  assert.match(r.output, /out/);
  assert.match(r.output, /err/);
  assert.equal(r.timedOut, false);
});

test("exit 0 on success", async () => {
  const r = await runCommand("true", tmpdir(), 10);
  assert.equal(r.exitCode, 0);
  assert.equal(r.timedOut, false);
});

test("runs in the given cwd", async () => {
  const r = await runCommand("pwd", "/", 10);
  assert.equal(r.output.trim(), "/");
});

test("times out, kills the process, and annotates output", async () => {
  const r = await runCommand("sleep 5", tmpdir(), 1);
  assert.equal(r.timedOut, true);
  assert.equal(r.exitCode, null);
  assert.match(r.output, /timeout after 1s/);
});
