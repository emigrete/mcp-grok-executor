import { spawn, type ChildProcess } from "node:child_process";

export type CommandResult = {
  exitCode: number | null;
  /** stdout and stderr merged in arrival order */
  output: string;
  timedOut: boolean;
};

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

/** Run one shell command (via `sh -c`) with a hard timeout. Same trust level
 *  as execute_task: callers pass user/advisor-approved commands only. */
export async function runCommand(
  command: string,
  cwd: string,
  timeoutSec: number,
  signal?: AbortSignal,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({
        exitCode: null,
        output: "\n[cancelled]",
        timedOut: false,
      });
      return;
    }

    const child = spawn("sh", ["-c", command], {
      cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let output = "";
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => (output += d));
    child.stderr?.on("data", (d: string) => (output += d));

    const onAbort = () => {
      cancelled = true;
      killTree(child, "SIGTERM");
      setTimeout(() => {
        killTree(child, "SIGKILL");
      }, 2000).unref();
      finish(null);
    };

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      let out = output;
      if (timedOut) out += `\n[timeout after ${timeoutSec}s]`;
      else if (cancelled) out += "\n[cancelled]";
      resolve({
        exitCode: timedOut || cancelled ? null : exitCode,
        output: out,
        timedOut,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, "SIGTERM");
      setTimeout(() => {
        killTree(child, "SIGKILL");
      }, 2000).unref();
      finish(null);
    }, timeoutSec * 1000);

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (err) => {
      output += `\n[spawn error] ${err.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}
