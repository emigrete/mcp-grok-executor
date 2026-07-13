import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("loadJobs restores metas and marks running orphans failed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mgx-jobs-"));
  process.env.MCP_GROK_CACHE_DIR = dir;

  const jobsDir = join(dir, "jobs");
  await mkdir(jobsDir, { recursive: true });

  const completedId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const runningId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const startedAt = "2026-01-01T00:00:00.000Z";

  const completed = {
    id: completedId,
    state: "completed" as const,
    mode: "execute" as const,
    prompt: "done work",
    cwd: dir,
    startedAt,
    finishedAt: "2026-01-01T00:01:00.000Z",
    exitCode: 0,
    logPath: join(jobsDir, `${completedId}.log`),
  };

  const running = {
    id: runningId,
    state: "running" as const,
    mode: "execute" as const,
    prompt: "still going",
    cwd: dir,
    startedAt,
    logPath: join(jobsDir, `${runningId}.log`),
  };

  await writeFile(
    join(jobsDir, `${completedId}.json`),
    JSON.stringify(completed, null, 2),
    "utf8",
  );
  await writeFile(
    join(jobsDir, `${runningId}.json`),
    JSON.stringify(running, null, 2),
    "utf8",
  );

  const { loadJobs, getJob } = await import("./jobs.js");

  const restored = await loadJobs();
  assert.equal(restored, 2);

  const done = getJob(completedId);
  assert.ok(done);
  assert.equal(done!.state, "completed");
  assert.equal(done!.error, undefined);
  assert.equal(done!.finishedAt, completed.finishedAt);

  const orphan = getJob(runningId);
  assert.ok(orphan);
  assert.equal(orphan!.state, "failed");
  assert.equal(orphan!.error, "server restart");
  assert.ok(orphan!.finishedAt);

  const again = await loadJobs();
  assert.equal(again, 0);
});
