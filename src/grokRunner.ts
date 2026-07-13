import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { config } from "./config.js";
import { checkGrokAuth } from "./auth.js";
import {
  appendJobLog,
  createJob,
  trackChild,
  updateJob,
  type JobRecord,
} from "./jobs.js";
import {
  StreamParser,
  formatEvent,
  type GrokStreamEvent,
} from "./streamEvents.js";
import type { GrokTransport } from "./transport.js";
import { acpTransport } from "./acpTransport.js";

export type RunMode = "execute" | "review" | "continue";

export type GrokRunOptions = {
  prompt: string;
  cwd: string;
  mode: RunMode;
  model?: string;
  maxTurns?: number;
  timeoutSec?: number;
  /** Resume a previous Grok session id (UUID) */
  sessionId?: string;
  /** Continue most recent session in cwd */
  continueRecent?: boolean;
  /** When mode is continue, whether to allow mutations */
  mutate?: boolean;
  /** Run detached and return job_id immediately */
  background?: boolean;
  /** Live parsed stream events (thought/text/end/raw) as they arrive */
  onEvent?: (ev: GrokStreamEvent) => void;
  /** Abort in-flight grok process (process-group kill) */
  signal?: AbortSignal;
};

export type GrokRunResult = {
  ok: boolean;
  mode: RunMode;
  exitCode: number | null;
  durationMs: number;
  cwd: string;
  sessionId?: string;
  jobId?: string;
  summary: string;
  stdout: string;
  stderr: string;
  logPath?: string;
  command: string[];
  authOk: boolean;
  error?: string;
  usage?: { numTurns?: number; totalTokens?: number };
  /** True when the run produced output but no parseable stream events — the grok CLI stream format may have changed. */
  streamDegraded?: boolean;
};

function truncate(text: string, max = config.maxOutputChars): string {
  if (text.length <= max) return text;
  return (
    text.slice(0, max) +
    `\n\n…[truncated ${text.length - max} chars; see log file if available]`
  );
}

function wantsMutation(opts: GrokRunOptions): boolean {
  if (opts.mode === "review") return false;
  if (opts.mode === "execute") return true;
  // continue
  return opts.mutate !== false;
}

function buildArgs(
  opts: GrokRunOptions,
  createdSessionId?: string,
): { args: string[]; effectiveSessionId?: string } {
  const args: string[] = ["--no-auto-update", "--cwd", opts.cwd];
  const mutate = wantsMutation(opts);

  if (mutate) {
    args.push("--always-approve");
  } else {
    args.push("--tools", config.reviewTools);
    args.push("--disallowed-tools", config.reviewDisallowedTools);
  }

  const model = opts.model ?? config.defaultModel;
  if (model) {
    args.push("-m", model);
  }
  if (opts.maxTurns !== undefined) {
    args.push("--max-turns", String(opts.maxTurns));
  }

  let effectiveSessionId: string | undefined;

  if (opts.continueRecent) {
    args.push("-c");
    effectiveSessionId = opts.sessionId;
  } else if (opts.sessionId) {
    // Resume existing session
    args.push("-r", opts.sessionId);
    effectiveSessionId = opts.sessionId;
  } else if (createdSessionId) {
    // Fresh named session so continue_task can resume later
    args.push("-s", createdSessionId);
    effectiveSessionId = createdSessionId;
  }

  args.push("--output-format", "streaming-json");

  let prompt = opts.prompt;
  if (!mutate) {
    prompt =
      `${opts.prompt}\n\n` +
      `[SYSTEM CONSTRAINT FROM MCP BRIDGE]\n` +
      `This is a READ-ONLY review. Do not create, edit, delete, or move any files. ` +
      `Do not run shell commands that mutate the system. ` +
      `Only analyze and report findings in your response.`;
  }

  args.push("-p", prompt);
  return { args, effectiveSessionId };
}

function extractSummary(stdout: string, stderr: string): string {
  const text = stdout.trim() || stderr.trim();
  if (!text) return "(no output)";

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed.result === "string") return parsed.result;
    if (typeof parsed.message === "string") return parsed.message;
    if (typeof parsed.content === "string") return parsed.content;
    if (typeof parsed.text === "string") return parsed.text;
  } catch {
    const lines = text.split("\n").filter((l) => l.trim().startsWith("{"));
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]!) as Record<string, unknown>;
        if (typeof parsed.result === "string") return parsed.result;
        if (typeof parsed.message === "string") return parsed.message;
      } catch {
        /* continue */
      }
    }
  }

  const chunks = text.split("\n").filter((l) => l.trim());
  return chunks.slice(-40).join("\n");
}

type EndEvent = Extract<GrokStreamEvent, { kind: "end" }>;

function makeStreamCollector(onEvent?: (ev: GrokStreamEvent) => void) {
  const parser = new StreamParser();
  let text = "";
  let end: EndEvent | undefined;
  const handle = (evs: GrokStreamEvent[]) => {
    for (const ev of evs) {
      if (ev.kind === "text") text += ev.text;
      if (ev.kind === "end") end = ev;
      onEvent?.(ev);
    }
  };
  return {
    onStdout: (d: string) => handle(parser.push(d)),
    finish: () => handle(parser.flush()),
    get text() {
      return text;
    },
    get end() {
      return end;
    },
  };
}

function killTree(child: ChildProcess, sig: NodeJS.Signals): void {
  try {
    if (child.pid !== undefined) {
      process.kill(-child.pid, sig);
      return;
    }
  } catch {
    /* fall through to direct kill */
  }
  try {
    child.kill(sig);
  } catch {
    /* ignore */
  }
}

function spawnGrok(
  args: string[],
  cwd: string,
): { child: ChildProcess; command: string[] } {
  const command = [config.grokBin, ...args];
  const child = spawn(config.grokBin, args, {
    cwd,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  return { child, command };
}

async function waitForChild(
  child: ChildProcess,
  timeoutSec: number,
  onChunk?: (stream: "stdout" | "stderr", data: string) => void,
): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let settled = false;

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (d: string) => {
    stdout += d;
    onChunk?.("stdout", d);
  });
  child.stderr?.on("data", (d: string) => {
    stderr += d;
    onChunk?.("stderr", d);
  });

  const timeoutMs = timeoutSec * 1000;

  const exitCode = await new Promise<number | null>((resolve) => {
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, "SIGTERM");
      setTimeout(() => {
        killTree(child, "SIGKILL");
      }, 2000).unref();
      finish(null);
    }, timeoutMs);

    child.on("error", (err) => {
      stderr += `\n[spawn error] ${err.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });

  return {
    exitCode: timedOut ? null : exitCode,
    stdout,
    stderr: timedOut
      ? stderr + `\n[timeout after ${timeoutSec}s]`
      : stderr,
    timedOut,
  };
}

function jobMode(opts: GrokRunOptions): "execute" | "review" | "continue" {
  if (opts.mode === "continue") return "continue";
  return wantsMutation(opts) ? "execute" : "review";
}

/**
 * CLI transport: spawn `grok -p …` headless. For background=true, returns
 * immediately with jobId.
 */
async function cliRun(opts: GrokRunOptions): Promise<GrokRunResult> {
  const started = Date.now();
  const auth = await checkGrokAuth();
  if (!auth.ok) {
    return {
      ok: false,
      mode: opts.mode,
      exitCode: null,
      durationMs: Date.now() - started,
      cwd: opts.cwd,
      summary: auth.message,
      stdout: "",
      stderr: "",
      command: [],
      authOk: false,
      error: auth.message,
    };
  }

  // New sessions get a UUID so continue_task can resume them.
  // Resume / -c paths do not create a new id.
  const createNewSession =
    !opts.sessionId && !opts.continueRecent && opts.mode !== "continue";
  const createdSessionId = createNewSession ? randomUUID() : undefined;

  // continue without session_id → most recent in cwd
  const runOpts: GrokRunOptions = {
    ...opts,
    continueRecent:
      opts.continueRecent ||
      (opts.mode === "continue" && !opts.sessionId) ||
      false,
  };

  const { args, effectiveSessionId } = buildArgs(runOpts, createdSessionId);
  const timeoutSec = opts.timeoutSec ?? config.defaultTimeoutSec;

  if (opts.background) {
    const job = await createJob({
      mode: jobMode(opts),
      prompt: opts.prompt,
      cwd: opts.cwd,
      sessionId: effectiveSessionId,
    });
    const collector = makeStreamCollector((ev) => {
      opts.onEvent?.(ev);
      void appendJobLog(job.id, formatEvent(ev) + "\n");
    });
    const { child, command } = spawnGrok(args, opts.cwd);
    if (child.pid) {
      await updateJob(job.id, { pid: child.pid });
    }
    trackChild(job.id, child);

    const onAbort = () => {
      killTree(child, "SIGTERM");
      setTimeout(() => {
        killTree(child, "SIGKILL");
      }, 2000).unref();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    const clearAbort = () => {
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    };
    child.on("close", clearAbort);

    void (async () => {
      const result = await waitForChild(child, timeoutSec, (stream, data) => {
        if (stream === "stdout") collector.onStdout(data);
        else void appendJobLog(job.id, data);
      });
      clearAbort();
      collector.finish();
      const summary =
        collector.text.trim() || extractSummary(result.stdout, result.stderr);
      await appendJobLog(
        job.id,
        `\n---\nsummary:\n${summary}\nexit=${result.exitCode}\n`,
      );
      await updateJob(job.id, {
        state: result.timedOut
          ? "failed"
          : result.exitCode === 0
            ? "completed"
            : "failed",
        finishedAt: new Date().toISOString(),
        exitCode: result.exitCode,
        sessionId: collector.end?.sessionId ?? effectiveSessionId,
        error: result.timedOut ? `Timeout after ${timeoutSec}s` : undefined,
      });
    })();

    return {
      ok: true,
      mode: opts.mode,
      exitCode: null,
      durationMs: Date.now() - started,
      cwd: opts.cwd,
      sessionId: effectiveSessionId,
      jobId: job.id,
      summary: `Background job started: ${job.id}. Use task_status to poll.`,
      stdout: "",
      stderr: "",
      logPath: job.logPath,
      command,
      authOk: true,
    };
  }

  const collector = makeStreamCollector(opts.onEvent);
  const { child, command } = spawnGrok(args, opts.cwd);

  const onAbort = () => {
    killTree(child, "SIGTERM");
    setTimeout(() => {
      killTree(child, "SIGKILL");
    }, 2000).unref();
  };
  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }
  const clearAbort = () => {
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
  };
  child.on("close", clearAbort);

  const result = await waitForChild(child, timeoutSec, (stream, data) => {
    if (stream === "stdout") collector.onStdout(data);
  });
  clearAbort();
  collector.finish();
  const streamDegraded =
    result.exitCode === 0 &&
    !collector.text.trim() &&
    !collector.end &&
    result.stdout.trim().length > 0;
  const summary =
    collector.text.trim() || extractSummary(result.stdout, result.stderr);
  const finalSessionId = collector.end?.sessionId ?? effectiveSessionId;
  const ok = !result.timedOut && result.exitCode === 0;

  let logPath: string | undefined;
  try {
    const job = await createJob({
      mode: jobMode(opts),
      prompt: opts.prompt,
      cwd: opts.cwd,
      sessionId: finalSessionId,
      state: ok ? "completed" : "failed",
      finishedAt: new Date().toISOString(),
      exitCode: result.exitCode,
      pid: child.pid,
      error: result.timedOut ? `Timeout after ${timeoutSec}s` : undefined,
    });
    logPath = job.logPath;
    await writeFile(
      job.logPath,
      `COMMAND: ${command.map(shellQuote).join(" ")}\n\n` +
        `--- STDOUT ---\n${result.stdout}\n\n--- STDERR ---\n${result.stderr}\n`,
      "utf8",
    );
  } catch {
    /* non-fatal */
  }

  return {
    ok,
    mode: opts.mode,
    exitCode: result.exitCode,
    durationMs: Date.now() - started,
    cwd: opts.cwd,
    sessionId: finalSessionId,
    summary: truncate(summary),
    stdout: truncate(result.stdout),
    stderr: truncate(result.stderr),
    logPath,
    command,
    authOk: true,
    usage: collector.end
      ? { numTurns: collector.end.numTurns, totalTokens: collector.end.totalTokens }
      : undefined,
    streamDegraded: streamDegraded || undefined,
    error: result.timedOut
      ? `Timeout after ${timeoutSec}s`
      : ok
        ? undefined
        : `grok exited with code ${result.exitCode}`,
  };
}

export const cliTransport: GrokTransport = { name: "cli", run: cliRun };

/**
 * Run Grok headless. Dispatches to the configured transport (cli or acp).
 * For background=true, returns immediately with jobId (CLI only — ACP is sync).
 */
export async function runGrok(opts: GrokRunOptions): Promise<GrokRunResult> {
  // ACP can't restrict tools (review), resume "most recent" (continue without
  // sessionId / continueRecent), or run detached background jobs — force CLI.
  const continueWithoutSession =
    opts.continueRecent || (opts.mode === "continue" && !opts.sessionId);
  if (opts.mode === "review" || continueWithoutSession || opts.background) {
    return cliTransport.run(opts);
  }

  if (config.transport === "acp") {
    return acpTransport.run(opts);
  }

  return cliTransport.run(opts);
}

function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9_./:@%+=,-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export type { JobRecord };
