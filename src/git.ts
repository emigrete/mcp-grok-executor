import { spawn } from "node:child_process";
import { config } from "./config.js";

export type GitEvidence = {
  isRepo: boolean;
  /** `git status --porcelain` output (truncated) */
  statusAfter: string | null;
  /** Paths parsed from porcelain status (includes untracked files) */
  changedFiles: string[] | null;
  /** `git diff HEAD` (or `git diff` when the repo has no commits), truncated.
   *  Untracked files do not appear here — see changedFiles. */
  diff: string | null;
  noChanges: boolean | null;
};

function runGit(
  args: string[],
  cwd: string,
): Promise<{ exitCode: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (stdout += d));
    child.on("error", () => resolve({ exitCode: null, stdout }));
    child.on("close", (code) => resolve({ exitCode: code, stdout }));
  });
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n…[truncated ${text.length - max} chars]`;
}

export async function gitEvidence(
  cwd: string,
  maxChars = config.maxOutputChars,
): Promise<GitEvidence> {
  const probe = await runGit(["rev-parse", "--is-inside-work-tree"], cwd);
  if (probe.exitCode !== 0 || probe.stdout.trim() !== "true") {
    return {
      isRepo: false,
      statusAfter: null,
      changedFiles: null,
      diff: null,
      noChanges: null,
    };
  }
  const status = (await runGit(["status", "--porcelain"], cwd)).stdout;
  const changedFiles = status
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => l.slice(3).trim());
  const hasHead =
    (await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], cwd)).exitCode === 0;
  const diff = (await runGit(hasHead ? ["diff", "HEAD"] : ["diff"], cwd)).stdout;
  return {
    isRepo: true,
    statusAfter: truncate(status, maxChars),
    changedFiles,
    diff: truncate(diff, maxChars),
    noChanges: changedFiles.length === 0,
  };
}
