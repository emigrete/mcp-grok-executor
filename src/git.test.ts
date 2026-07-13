import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { gitEvidence } from "./git.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    stdio: "ignore",
  });
}

test("non-repo directory reports isRepo false, null fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mgx-git-"));
  const ev = await gitEvidence(dir);
  assert.deepEqual(ev, {
    isRepo: false,
    statusAfter: null,
    changedFiles: null,
    diff: null,
    noChanges: null,
  });
});

test("detects new + modified files against HEAD", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mgx-git-"));
  git(dir, "init", "-b", "main");
  await writeFile(join(dir, "a.txt"), "v1\n", "utf8");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "init");
  await writeFile(join(dir, "a.txt"), "v2\n", "utf8"); // modified
  await writeFile(join(dir, "b.txt"), "new\n", "utf8"); // untracked
  const ev = await gitEvidence(dir);
  assert.equal(ev.isRepo, true);
  assert.deepEqual(ev.changedFiles?.sort(), ["a.txt", "b.txt"]);
  assert.equal(ev.noChanges, false);
  assert.match(ev.diff ?? "", /-v1/);
  assert.match(ev.diff ?? "", /\+v2/);
});

test("clean repo reports noChanges true", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mgx-git-"));
  git(dir, "init", "-b", "main");
  git(dir, "commit", "--allow-empty", "-m", "init");
  const ev = await gitEvidence(dir);
  assert.equal(ev.noChanges, true);
  assert.deepEqual(ev.changedFiles, []);
});

test("repo without any commit still works (no HEAD)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mgx-git-"));
  git(dir, "init", "-b", "main");
  await writeFile(join(dir, "x.txt"), "x\n", "utf8");
  const ev = await gitEvidence(dir);
  assert.equal(ev.isRepo, true);
  assert.deepEqual(ev.changedFiles, ["x.txt"]);
  assert.equal(ev.noChanges, false);
});
