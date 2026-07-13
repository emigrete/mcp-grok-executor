import { test } from "node:test";
import assert from "node:assert/strict";
import { runTaskLoop } from "./orchestrator.js";
import type { GrokRunResult } from "./grokRunner.js";
import type { GitEvidence } from "./git.js";

const okRun = (summary: string): GrokRunResult => ({
  ok: true,
  mode: "execute",
  exitCode: 0,
  durationMs: 5,
  cwd: "/x",
  sessionId: "s1",
  summary,
  stdout: "",
  stderr: "",
  command: [],
  authOk: true,
  usage: { numTurns: 1, totalTokens: 100 },
});

const dirtyGit: GitEvidence = {
  isRepo: true,
  statusAfter: " M a.ts",
  changedFiles: ["a.ts"],
  diff: "+x",
  noChanges: false,
};

test("happy path without verify_command", async () => {
  const r = await runTaskLoop(
    { prompt: "do", cwd: "/x" },
    { runGrok: async () => okRun("done"), gitEvidence: async () => dirtyGit },
  );
  assert.equal(r.ok, true);
  assert.equal(r.attempts.length, 1);
  assert.equal(r.attempts[0]?.type, "execute");
  assert.equal(r.verify, null);
  assert.equal(r.sessionId, "s1");
  assert.equal(r.git.noChanges, false);
});

test("verify passes on the first try", async () => {
  const r = await runTaskLoop(
    { prompt: "do", cwd: "/x", verifyCommand: "npm test" },
    {
      runGrok: async () => okRun("done"),
      gitEvidence: async () => dirtyGit,
      runCommand: async () => ({ exitCode: 0, output: "ok", timedOut: false }),
    },
  );
  assert.equal(r.ok, true);
  assert.equal(r.verify?.attemptsUsed, 1);
  assert.equal(r.attempts.length, 1);
});

test("fix loop converges on the second verify", async () => {
  let verifies = 0;
  const prompts: string[] = [];
  const r = await runTaskLoop(
    { prompt: "do", cwd: "/x", verifyCommand: "npm test" },
    {
      runGrok: async (o) => {
        prompts.push(o.prompt);
        return okRun("done");
      },
      gitEvidence: async () => dirtyGit,
      runCommand: async () =>
        ++verifies === 1
          ? { exitCode: 1, output: "1 failing", timedOut: false }
          : { exitCode: 0, output: "ok", timedOut: false },
    },
  );
  assert.equal(r.ok, true);
  assert.equal(r.attempts.length, 2);
  assert.equal(r.attempts[1]?.type, "fix");
  assert.match(prompts[1] ?? "", /VERIFICATION FAILED \(attempt 1\/2\)/);
  assert.match(prompts[1] ?? "", /1 failing/);
  assert.equal(r.verify?.attemptsUsed, 2);
  assert.equal(r.attempts[0]?.usage?.totalTokens, 100);
  assert.equal(r.totalTokens, 200);
});

test("totalTokens is undefined when no attempt reports usage", async () => {
  const r = await runTaskLoop(
    { prompt: "do", cwd: "/x" },
    {
      runGrok: async () => {
        const run = okRun("done");
        delete run.usage;
        return run;
      },
      gitEvidence: async () => dirtyGit,
    },
  );
  assert.equal(r.ok, true);
  assert.equal(r.attempts.length, 1);
  assert.equal(r.attempts[0]?.usage, undefined);
  assert.equal(r.totalTokens, undefined);
});

test("returns ok false with evidence after exhausting fix attempts", async () => {
  const r = await runTaskLoop(
    { prompt: "do", cwd: "/x", verifyCommand: "npm test", maxFixAttempts: 1 },
    {
      runGrok: async () => okRun("done"),
      gitEvidence: async () => dirtyGit,
      runCommand: async () => ({ exitCode: 2, output: "boom", timedOut: false }),
    },
  );
  assert.equal(r.ok, false);
  assert.equal(r.attempts.length, 2); // execute + 1 fix
  assert.equal(r.verify?.attemptsUsed, 2); // 2 verify runs
  assert.match(r.error ?? "", /failed after 1 fix attempt/);
});

test("maxFixAttempts 0 disables the fix loop", async () => {
  const r = await runTaskLoop(
    { prompt: "do", cwd: "/x", verifyCommand: "npm test", maxFixAttempts: 0 },
    {
      runGrok: async () => okRun("done"),
      gitEvidence: async () => dirtyGit,
      runCommand: async () => ({ exitCode: 1, output: "no", timedOut: false }),
    },
  );
  assert.equal(r.ok, false);
  assert.equal(r.attempts.length, 1); // execute only, no fix dispatched
  assert.equal(r.verify?.attemptsUsed, 1);
});

test("grok failure aborts immediately without verifying", async () => {
  const r = await runTaskLoop(
    { prompt: "do", cwd: "/x", verifyCommand: "npm test" },
    {
      runGrok: async () => ({ ...okRun(""), ok: false, error: "exploded" }),
      gitEvidence: async () => dirtyGit,
      runCommand: async () => {
        throw new Error("must not be called");
      },
    },
  );
  assert.equal(r.ok, false);
  assert.equal(r.error, "exploded");
  assert.equal(r.verify, null);
});

test("verify timeout feeds the fix loop", async () => {
  let calls = 0;
  const r = await runTaskLoop(
    { prompt: "do", cwd: "/x", verifyCommand: "slow", maxFixAttempts: 1 },
    {
      runGrok: async () => okRun("done"),
      gitEvidence: async () => dirtyGit,
      runCommand: async () =>
        ++calls === 1
          ? { exitCode: null, output: "[timeout after 300s]", timedOut: true }
          : { exitCode: 0, output: "ok", timedOut: false },
    },
  );
  assert.equal(r.ok, true);
  assert.equal(r.attempts.length, 2);
});

test("fix runs continue the same session", async () => {
  const modes: Array<{ mode: string; sessionId?: string }> = [];
  let verifies = 0;
  await runTaskLoop(
    { prompt: "do", cwd: "/x", verifyCommand: "t" },
    {
      runGrok: async (o) => {
        modes.push({ mode: o.mode, sessionId: o.sessionId });
        return okRun("done");
      },
      gitEvidence: async () => dirtyGit,
      runCommand: async () =>
        ++verifies === 1
          ? { exitCode: 1, output: "no", timedOut: false }
          : { exitCode: 0, output: "ok", timedOut: false },
    },
  );
  assert.deepEqual(modes[0], { mode: "execute", sessionId: undefined });
  assert.deepEqual(modes[1], { mode: "continue", sessionId: "s1" });
});

test("abort between execute and verify skips verify", async () => {
  const ac = new AbortController();
  const r = await runTaskLoop(
    { prompt: "do", cwd: "/x", verifyCommand: "npm test", signal: ac.signal },
    {
      runGrok: async () => {
        ac.abort();
        return okRun("done");
      },
      gitEvidence: async () => dirtyGit,
      runCommand: async () => {
        throw new Error("must not be called");
      },
    },
  );
  assert.equal(r.ok, false);
  assert.equal(r.error, "cancelled");
  assert.equal(r.verify, null);
});

test("needs_advisor short-circuits before verify", async () => {
  const progress: string[] = [];
  const r = await runTaskLoop(
    {
      prompt: "do",
      cwd: "/x",
      verifyCommand: "npm test",
      onProgress: (line) => progress.push(line),
    },
    {
      runGrok: async () =>
        okRun("I did some analysis.\nNEEDS_ADVISOR: should I drop the legacy table?"),
      gitEvidence: async () => dirtyGit,
      runCommand: async () => {
        throw new Error("must not be called");
      },
    },
  );
  assert.equal(r.ok, false);
  assert.equal(r.status, "needs_advisor");
  assert.equal(r.question, "should I drop the legacy table?");
  assert.equal(r.verify, null);
  assert.equal(r.sessionId, "s1");
  assert.ok(
    progress.some((p) => p.includes("grok needs the advisor: should I drop the legacy table?")),
  );
});

test("needs_advisor from a fix run also short-circuits", async () => {
  let verifies = 0;
  let grokCalls = 0;
  const r = await runTaskLoop(
    { prompt: "do", cwd: "/x", verifyCommand: "npm test", maxFixAttempts: 2 },
    {
      runGrok: async () => {
        grokCalls++;
        if (grokCalls === 1) return okRun("initial work");
        return okRun("stuck.\nNEEDS_ADVISOR: which API version should we target?");
      },
      gitEvidence: async () => dirtyGit,
      runCommand: async () => {
        verifies++;
        return { exitCode: 1, output: "fail", timedOut: false };
      },
    },
  );
  assert.equal(r.ok, false);
  assert.equal(r.status, "needs_advisor");
  assert.equal(r.question, "which API version should we target?");
  assert.equal(r.verify?.attemptsUsed, 1);
  assert.equal(r.attempts.length, 2);
  assert.equal(verifies, 1);
});

test("needs_advisor detected when glued without newline", async () => {
  const r = await runTaskLoop(
    { prompt: "do", cwd: "/x", verifyCommand: "npm test" },
    {
      runGrok: async () =>
        okRun(
          "I checked both files.NEEDS_ADVISOR: which config file is the duplicate?",
        ),
      gitEvidence: async () => dirtyGit,
      runCommand: async () => {
        throw new Error("must not be called");
      },
    },
  );
  assert.equal(r.status, "needs_advisor");
  assert.equal(r.question, "which config file is the duplicate?");
});

test("last occurrence wins", async () => {
  const r = await runTaskLoop(
    { prompt: "do", cwd: "/x" },
    {
      runGrok: async () =>
        okRun(
          "The protocol says I could use NEEDS_ADVISOR: like this.\nSome more work.\nNEEDS_ADVISOR: real question?",
        ),
      gitEvidence: async () => dirtyGit,
    },
  );
  assert.equal(r.status, "needs_advisor");
  assert.equal(r.question, "real question?");
});

test("advisor protocol is appended to prompts", async () => {
  const prompts: string[] = [];
  let verifies = 0;
  await runTaskLoop(
    { prompt: "do the thing", cwd: "/x", verifyCommand: "t" },
    {
      runGrok: async (o) => {
        prompts.push(o.prompt);
        return okRun("done");
      },
      gitEvidence: async () => dirtyGit,
      runCommand: async () =>
        ++verifies === 1
          ? { exitCode: 1, output: "no", timedOut: false }
          : { exitCode: 0, output: "ok", timedOut: false },
    },
  );
  assert.equal(prompts.length, 2);
  assert.match(prompts[0] ?? "", /NEEDS_ADVISOR:/);
  assert.match(prompts[1] ?? "", /NEEDS_ADVISOR:/);
  assert.match(prompts[0] ?? "", /do the thing/);
  assert.match(prompts[1] ?? "", /VERIFICATION FAILED/);
});

test("normal completion has status completed", async () => {
  const r = await runTaskLoop(
    { prompt: "do", cwd: "/x" },
    { runGrok: async () => okRun("done"), gitEvidence: async () => dirtyGit },
  );
  assert.equal(r.ok, true);
  assert.equal(r.status, "completed");
});

test("failure has status failed", async () => {
  const r = await runTaskLoop(
    { prompt: "do", cwd: "/x", verifyCommand: "npm test", maxFixAttempts: 0 },
    {
      runGrok: async () => okRun("done"),
      gitEvidence: async () => dirtyGit,
      runCommand: async () => ({ exitCode: 1, output: "no", timedOut: false }),
    },
  );
  assert.equal(r.ok, false);
  assert.equal(r.status, "failed");
});
