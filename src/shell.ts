import { spawn } from "node:child_process";

export type CommandResult = {
  exitCode: number | null;
  /** stdout and stderr merged in arrival order */
  output: string;
  timedOut: boolean;
};

/** Run one shell command (via `sh -c`) with a hard timeout. Same trust level
 *  as execute_task: callers pass user/advisor-approved commands only. */
export async function runCommand(
  command: string,
  cwd: string,
  timeoutSec: number,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], {
      cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    let settled = false;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => (output += d));
    child.stderr?.on("data", (d: string) => (output += d));

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        output: timedOut ? output + `\n[timeout after ${timeoutSec}s]` : output,
        timedOut,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 2000).unref();
      } catch {
        /* ignore */
      }
      finish(null);
    }, timeoutSec * 1000);

    child.on("error", (err) => {
      output += `\n[spawn error] ${err.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}
