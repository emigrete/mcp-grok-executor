import { runGrok as realRunGrok, type GrokRunResult } from "./grokRunner.js";
import { gitEvidence as realGitEvidence, type GitEvidence } from "./git.js";
import { runCommand as realRunCommand } from "./shell.js";
import type { GrokStreamEvent } from "./streamEvents.js";

export type RunTaskOptions = {
  prompt: string;
  cwd: string;
  verifyCommand?: string;
  /** Auto-fix rounds when verify fails. Default 2; 0 disables. */
  maxFixAttempts?: number;
  /** Timeout for each verify run. Default 300. */
  verifyTimeoutSec?: number;
  sessionId?: string;
  model?: string;
  maxTurns?: number;
  timeoutSec?: number;
  /** Loop-phase markers and progress lines (important=true → never throttle) */
  onProgress?: (line: string, important?: boolean) => void;
  /** Raw grok stream events, forwarded from every inner run */
  onEvent?: (ev: GrokStreamEvent) => void;
};

export type TaskAttempt = {
  type: "execute" | "fix";
  exitCode: number | null;
  summary: string;
  durationMs: number;
  usage?: { numTurns?: number; totalTokens?: number };
};

export type VerifyReport = {
  command: string;
  ran: boolean;
  exitCode: number | null;
  output: string;
  attemptsUsed: number;
};

export type RunTaskResult = {
  ok: boolean;
  sessionId?: string;
  attempts: TaskAttempt[];
  git: GitEvidence;
  verify: VerifyReport | null;
  durationMs: number;
  error?: string;
  /** Sum of attempt usage.totalTokens when at least one attempt reported it. */
  totalTokens?: number;
};

export type OrchestratorDeps = {
  runGrok: typeof realRunGrok;
  gitEvidence: typeof realGitEvidence;
  runCommand: typeof realRunCommand;
};

const DEFAULT_MAX_FIX_ATTEMPTS = 2;
const DEFAULT_VERIFY_TIMEOUT_SEC = 300;
/** Cap on verify output embedded in fix prompts (tail is most useful). */
const VERIFY_OUTPUT_PROMPT_CHARS = 8000;

function tailForPrompt(output: string): string {
  if (output.length <= VERIFY_OUTPUT_PROMPT_CHARS) return output;
  return "…" + output.slice(-VERIFY_OUTPUT_PROMPT_CHARS);
}

function fixPrompt(
  attempt: number,
  max: number,
  command: string,
  exitCode: number | null,
  output: string,
): string {
  return (
    `[MCP BRIDGE — VERIFICATION FAILED (attempt ${attempt}/${max})]\n` +
    `The verification command \`${command}\` exited ${exitCode ?? "null (timeout)"}.\n` +
    `Output (truncated):\n${tailForPrompt(output)}\n\n` +
    `Fix the underlying issues so the command passes. ` +
    `Do not weaken, skip, or delete tests.`
  );
}

/**
 * The advisor/executor loop: execute → git evidence → verify → auto-fix.
 * Retries ONLY on verify_command failure; a failed grok run aborts; an empty
 * diff is reported (git.noChanges) but never consumes retries.
 */
export async function runTaskLoop(
  opts: RunTaskOptions,
  deps?: Partial<OrchestratorDeps>,
): Promise<RunTaskResult> {
  const { runGrok, gitEvidence, runCommand } = {
    runGrok: realRunGrok,
    gitEvidence: realGitEvidence,
    runCommand: realRunCommand,
    ...deps,
  };
  const started = Date.now();
  const maxFix = opts.maxFixAttempts ?? DEFAULT_MAX_FIX_ATTEMPTS;
  const verifyTimeout = opts.verifyTimeoutSec ?? DEFAULT_VERIFY_TIMEOUT_SEC;
  const progress = (line: string) => opts.onProgress?.(line, true);
  const attempts: TaskAttempt[] = [];
  let sessionId = opts.sessionId;
  let verify: VerifyReport | null = null;

  const finish = async (ok: boolean, error?: string): Promise<RunTaskResult> => {
    let totalTokens: number | undefined;
    for (const a of attempts) {
      const t = a.usage?.totalTokens;
      if (typeof t === "number") {
        totalTokens = (totalTokens ?? 0) + t;
      }
    }
    return {
      ok,
      sessionId,
      attempts,
      git: await gitEvidence(opts.cwd),
      verify,
      durationMs: Date.now() - started,
      error,
      totalTokens,
    };
  };

  const grokStep = async (
    type: "execute" | "fix",
    prompt: string,
  ): Promise<GrokRunResult> => {
    progress(`── ${type}: grok run ${attempts.length + 1} ──`);
    const run = await runGrok({
      prompt,
      cwd: opts.cwd,
      mode: type === "execute" ? "execute" : "continue",
      mutate: true,
      model: opts.model,
      maxTurns: opts.maxTurns,
      timeoutSec: opts.timeoutSec,
      sessionId,
      onEvent: opts.onEvent,
    });
    attempts.push({
      type,
      exitCode: run.exitCode,
      summary: run.summary,
      durationMs: run.durationMs,
      usage: run.usage,
    });
    if (run.sessionId) sessionId = run.sessionId;
    return run;
  };

  const first = await grokStep("execute", opts.prompt);
  if (!first.ok) {
    return finish(false, first.error ?? "grok execute run failed");
  }

  if (!opts.verifyCommand) {
    return finish(true);
  }

  const cmd = opts.verifyCommand;
  for (let attempt = 0; ; attempt++) {
    progress(`── verify (${attempt + 1}): ${cmd} ──`);
    const res = await runCommand(cmd, opts.cwd, verifyTimeout);
    verify = {
      command: cmd,
      ran: true,
      exitCode: res.exitCode,
      output: res.output,
      attemptsUsed: attempt + 1,
    };
    if (res.exitCode === 0) {
      progress(`── verify passed ──`);
      return finish(true);
    }
    if (attempt >= maxFix) {
      progress(`── verify still failing; returning to advisor ──`);
      return finish(
        false,
        `verify_command failed after ${attempt} fix attempt(s)`,
      );
    }
    progress(`── verify failed (exit ${res.exitCode}); fix ${attempt + 1}/${maxFix} ──`);
    const fix = await grokStep(
      "fix",
      fixPrompt(attempt + 1, maxFix, cmd, res.exitCode, res.output),
    );
    if (!fix.ok) {
      return finish(false, fix.error ?? "grok fix run failed");
    }
  }
}
