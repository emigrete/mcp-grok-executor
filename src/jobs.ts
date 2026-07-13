import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { config } from "./config.js";

export type JobState = "running" | "completed" | "failed" | "cancelled";

export type JobRecord = {
  id: string;
  state: JobState;
  mode: "execute" | "review" | "continue";
  prompt: string;
  cwd: string;
  pid?: number;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  logPath: string;
  sessionId?: string;
  error?: string;
};

const jobs = new Map<string, JobRecord>();
const children = new Map<string, ChildProcess>();
const aborts = new Map<string, () => void>();

/** Register an abort callback for a job (e.g. AbortController.abort).
 *  Auto-cleans up after firing once. */
export function registerAbort(id: string, fn: () => void): void {
  const wrapped = () => {
    aborts.delete(id);
    fn();
  };
  aborts.set(id, wrapped);
}

export async function ensureCacheDir(): Promise<string> {
  const dir = join(config.cacheDir, "jobs");
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Load persisted job metas from the cache dir into memory. Call once at
 *  startup. Jobs still marked "running" are orphans from a previous server
 *  process — mark them failed. Returns the number of records loaded. */
export async function loadJobs(): Promise<number> {
  const dir = await ensureCacheDir();
  const entries = await readdir(dir);
  let loaded = 0;
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(dir, name), "utf8");
      const record = JSON.parse(raw) as JobRecord;
      if (jobs.has(record.id)) continue;
      if (record.state === "running") {
        record.state = "failed";
        record.error = "server restart";
        record.finishedAt = new Date().toISOString();
        await persistMeta(record);
      }
      jobs.set(record.id, record);
      loaded++;
    } catch {
      // skip silently on parse/read errors
    }
  }
  return loaded;
}

export function getJob(id: string): JobRecord | undefined {
  return jobs.get(id);
}

export function listJobs(): JobRecord[] {
  return [...jobs.values()].sort((a, b) =>
    a.startedAt < b.startedAt ? 1 : -1,
  );
}

export async function createJob(
  partial: Omit<JobRecord, "id" | "startedAt" | "logPath" | "state"> & {
    state?: JobState;
  },
): Promise<JobRecord> {
  const dir = await ensureCacheDir();
  const id = randomUUID();
  const logPath = join(dir, `${id}.log`);
  const record: JobRecord = {
    id,
    state: partial.state ?? "running",
    mode: partial.mode,
    prompt: partial.prompt,
    cwd: partial.cwd,
    pid: partial.pid,
    startedAt: new Date().toISOString(),
    finishedAt: partial.finishedAt,
    exitCode: partial.exitCode,
    logPath,
    sessionId: partial.sessionId,
    error: partial.error,
  };
  jobs.set(id, record);
  await persistMeta(record);
  return record;
}

export async function updateJob(
  id: string,
  patch: Partial<JobRecord>,
): Promise<JobRecord | undefined> {
  const cur = jobs.get(id);
  if (!cur) return undefined;
  const next = { ...cur, ...patch, id: cur.id, logPath: cur.logPath };
  jobs.set(id, next);
  await persistMeta(next);
  return next;
}

async function persistMeta(record: JobRecord): Promise<void> {
  const metaPath = record.logPath.replace(/\.log$/, ".json");
  await writeFile(metaPath, JSON.stringify(record, null, 2), "utf8");
}

export function trackChild(id: string, child: ChildProcess): void {
  children.set(id, child);
  child.on("exit", () => {
    children.delete(id);
  });
}

export function cancelJob(id: string): { ok: boolean; message: string } {
  const child = children.get(id);
  const job = jobs.get(id);
  if (!job) {
    return { ok: false, message: `Unknown job_id: ${id}` };
  }
  if (job.state !== "running") {
    return { ok: false, message: `Job ${id} is already ${job.state}` };
  }

  const fireAbort = () => {
    const abort = aborts.get(id);
    if (abort) {
      abort();
      aborts.delete(id);
    }
  };

  if (!child || child.killed) {
    fireAbort();
    void updateJob(id, {
      state: "cancelled",
      finishedAt: new Date().toISOString(),
      error: "No live process; marked cancelled",
    });
    return { ok: true, message: `Job ${id} marked cancelled (process gone)` };
  }
  try {
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, 2000);
    fireAbort();
    void updateJob(id, {
      state: "cancelled",
      finishedAt: new Date().toISOString(),
    });
    return { ok: true, message: `Sent SIGTERM to job ${id} (pid ${child.pid})` };
  } catch (err) {
    fireAbort();
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message };
  }
}

export async function readJobLog(
  id: string,
  maxChars = config.maxOutputChars,
): Promise<{ ok: boolean; text?: string; message?: string }> {
  const job = jobs.get(id);
  if (!job) return { ok: false, message: `Unknown job_id: ${id}` };
  try {
    const raw = await readFile(job.logPath, "utf8");
    if (raw.length <= maxChars) return { ok: true, text: raw };
    return {
      ok: true,
      text:
        raw.slice(0, maxChars) +
        `\n\n…[truncated ${raw.length - maxChars} chars; full log: ${job.logPath}]`,
    };
  } catch {
    return { ok: true, text: "(log not available yet)" };
  }
}

export async function appendJobLog(id: string, chunk: string): Promise<void> {
  const job = jobs.get(id);
  if (!job) return;
  const { appendFile } = await import("node:fs/promises");
  await appendFile(job.logPath, chunk, "utf8");
}
