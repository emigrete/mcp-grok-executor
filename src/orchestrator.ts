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
  /** Abort in-flight grok runs and verify commands; checked between steps */
  signal?: AbortSignal;
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
  /** Outcome of the loop. needs_advisor ⇒ ok is false; resume via continue_task. */
  status: "completed" | "failed" | "needs_advisor";
  sessionId?: string;
  attempts: TaskAttempt[];
  git: GitEvidence;
  verify: VerifyReport | null;
  durationMs: number;
  error?: string;
  /** Populated when status is needs_advisor — the executor's question for the advisor. */
  question?: string;
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

const ADVISOR_PROTOCOL =
  "\n\n[MCP BRIDGE — ADVISOR PROTOCOL]\n" +
  "If you hit a decision that genuinely belongs to the architect (ambiguous requirement, " +
  "destructive/irreversible action, conflicting constraints), do NOT guess and do NOT make " +
  "speculative changes. End your turn with a single line:\n" +
  "NEEDS_ADVISOR: <one concise question>\n" +
  "Only use it when blocked; otherwise finish the task normally.";

/** The executor protocol says "end your turn with NEEDS_ADVISOR: …", but the
 *  stream collector may glue message segments without newlines. Detect the
 *  LAST occurrence anywhere and capture to end of line (or end of text). */
function detectAdvisorQuestion(summary: string): string | undefined {
  const idx = summary.lastIndexOf("NEEDS_ADVISOR:");
  if (idx === -1) return undefined;
  const rest = summary.slice(idx + "NEEDS_ADVISOR:".length);
  const line = rest.split("\n", 1)[0]?.trim();
  return line || undefined;
}

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

  const finish = async (
    ok: boolean,
    error?: string,
    extra?: { status?: "completed" | "failed" | "needs_advisor"; question?: string },
  ): Promise<RunTaskResult> => {
    let totalTokens: number | undefined;
    for (const a of attempts) {
      const t = a.usage?.totalTokens;
      if (typeof t === "number") {
        totalTokens = (totalTokens ?? 0) + t;
      }
    }
    const status =
      extra?.status ?? (ok ? "completed" : "failed");
    return {
      ok,
      status,
      sessionId,
      attempts,
      git: await gitEvidence(opts.cwd),
      verify,
      durationMs: Date.now() - started,
      error,
      question: extra?.question,
      totalTokens,
    };
  };

  const grokStep = async (
    type: "execute" | "fix",
    prompt: string,
  ): Promise<GrokRunResult> => {
    progress(`── ${type}: grok run ${attempts.length + 1} ──`);
    const run = await runGrok({
      prompt: prompt + ADVISOR_PROTOCOL,
      cwd: opts.cwd,
      mode: type === "execute" ? "execute" : "continue",
      mutate: true,
      model: opts.model,
      maxTurns: opts.maxTurns,
      timeoutSec: opts.timeoutSec,
      sessionId,
      onEvent: opts.onEvent,
      signal: opts.signal,
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
  const firstQuestion = detectAdvisorQuestion(first.summary);
  if (firstQuestion !== undefined) {
    progress(`── grok needs the advisor: ${firstQuestion} ──`);
    return finish(false, undefined, {
      status: "needs_advisor",
      question: firstQuestion,
    });
  }
  if (opts.signal?.aborted) {
    return finish(false, "cancelled");
  }

  if (!opts.verifyCommand) {
    return finish(true);
  }

  const cmd = opts.verifyCommand;
  for (let attempt = 0; ; attempt++) {
    progress(`── verify (${attempt + 1}): ${cmd} ──`);
    const res = await runCommand(cmd, opts.cwd, verifyTimeout, opts.signal);
    verify = {
      command: cmd,
      ran: true,
      exitCode: res.exitCode,
      output: res.output,
      attemptsUsed: attempt + 1,
    };
    if (opts.signal?.aborted) {
      return finish(false, "cancelled");
    }
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
    const fixQuestion = detectAdvisorQuestion(fix.summary);
    if (fixQuestion !== undefined) {
      progress(`── grok needs the advisor: ${fixQuestion} ──`);
      return finish(false, undefined, {
        status: "needs_advisor",
        question: fixQuestion,
      });
    }
    if (opts.signal?.aborted) {
      return finish(false, "cancelled");
    }
  }
}
