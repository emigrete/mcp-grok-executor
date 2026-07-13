import { z } from "zod";
import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { checkGrokAuth } from "./auth.js";
import { config } from "./config.js";
import { runGrok } from "./grokRunner.js";
import { formatEvent } from "./streamEvents.js";
import { runTaskLoop } from "./orchestrator.js";
import {
  appendJobLog,
  cancelJob,
  createJob,
  getJob,
  listJobs,
  readJobLog,
  updateJob,
} from "./jobs.js";

const commonShape = {
  prompt: z
    .string()
    .min(1)
    .describe(
      "Task instructions for Grok (be specific about files, tests, constraints)",
    ),
  cwd: z
    .string()
    .min(1)
    .describe("Absolute path to the target project working directory"),
  model: z
    .string()
    .optional()
    .describe("Optional Grok model id (defaults to CLI / MCP_GROK_MODEL)"),
  max_turns: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max agentic turns for Grok"),
  timeout_sec: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`Timeout in seconds (default ${config.defaultTimeoutSec})`),
  background: z
    .boolean()
    .optional()
    .describe(
      "If true, start Grok in background and return job_id immediately",
    ),
};

function textResult(payload: unknown, isError = false) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          typeof payload === "string"
            ? payload
            : JSON.stringify(payload, null, 2),
      },
    ],
    isError,
  };
}

function normalizeCwd(cwd: string): string {
  return resolve(cwd);
}

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Progress notifications for the client's spinner. Undefined when the client
 *  did not request progress (no progressToken). Never throws. */
export function makeProgressReporter(
  extra: ToolExtra,
  minIntervalMs = 500,
): ((line: string, important?: boolean) => void) | undefined {
  const token = extra._meta?.progressToken;
  if (token === undefined) return undefined;
  let progress = 0;
  let lastSent = 0;
  return (line: string, important = false) => {
    const now = Date.now();
    if (!important && now - lastSent < minIntervalMs) return;
    lastSent = now;
    progress += 1;
    void extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress, message: line.slice(0, 300) },
      })
      .catch(() => {
        /* progress is best-effort */
      });
  };
}

export function registerTools(server: McpServer): void {
  server.registerTool(
    "auth_status",
    {
      description:
        "Check whether Grok CLI is logged in via ~/.grok/auth.json (subscription OAuth). Call this before first use if unsure.",
      inputSchema: {},
    },
    async () => {
      const status = await checkGrokAuth();
      return textResult(
        {
          ...status,
          grokBin: config.grokBin,
          defaultTimeoutSec: config.defaultTimeoutSec,
          cacheDir: config.cacheDir,
        },
        !status.ok,
      );
    },
  );

  server.registerTool(
    "review_task",
    {
      description:
        "READ-ONLY: Ask Grok to analyze code, review a plan/diff, or answer questions without mutating files. Prefer this before execute_task. Grok runs without --always-approve and with write/shell tools disabled.",
      inputSchema: commonShape,
    },
    async (args, extra) => {
      const report = makeProgressReporter(extra);
      const result = await runGrok({
        prompt: args.prompt,
        cwd: normalizeCwd(args.cwd),
        mode: "review",
        model: args.model,
        maxTurns: args.max_turns,
        timeoutSec: args.timeout_sec,
        background: args.background,
        onEvent: report ? (ev) => report(formatEvent(ev)) : undefined,
      });
      return textResult(result, !result.ok);
    },
  );

  server.registerTool(
    "execute_task",
    {
      description:
        "MUTATING: Delegate implementation to Grok (file edits, tests, shell). Uses --always-approve. Only call after the user approved a plan or explicitly asked to implement. Verify with git diff/tests afterwards. Returns session_id for continue_task.",
      inputSchema: {
        ...commonShape,
        session_id: z
          .string()
          .uuid()
          .optional()
          .describe(
            "Optional UUID to create/resume a named Grok session for multi-step work",
          ),
      },
    },
    async (args, extra) => {
      const report = makeProgressReporter(extra);
      const result = await runGrok({
        prompt: args.prompt,
        cwd: normalizeCwd(args.cwd),
        mode: "execute",
        model: args.model,
        maxTurns: args.max_turns,
        timeoutSec: args.timeout_sec,
        sessionId: args.session_id,
        background: args.background,
        onEvent: report ? (ev) => report(formatEvent(ev)) : undefined,
      });
      return textResult(result, !result.ok);
    },
  );

  server.registerTool(
    "continue_task",
    {
      description:
        "Continue a previous Grok execution session with a follow-up prompt (e.g. fix failing tests). Prefer session_id from a prior execute_task; otherwise continues the most recent session in cwd.",
      inputSchema: {
        ...commonShape,
        session_id: z
          .string()
          .uuid()
          .optional()
          .describe("Session UUID returned by a previous execute_task"),
        mutate: z
          .boolean()
          .optional()
          .describe(
            "If true (default), run as execution with --always-approve. If false, continue in review/read-only mode.",
          ),
      },
    },
    async (args, extra) => {
      const report = makeProgressReporter(extra);
      const mutate = args.mutate !== false;
      const result = await runGrok({
        prompt: args.prompt,
        cwd: normalizeCwd(args.cwd),
        mode: "continue",
        mutate,
        model: args.model,
        maxTurns: args.max_turns,
        timeoutSec: args.timeout_sec,
        sessionId: args.session_id,
        continueRecent: !args.session_id,
        background: args.background,
        onEvent: report ? (ev) => report(formatEvent(ev)) : undefined,
      });
      return textResult(result, !result.ok);
    },
  );

  server.registerTool(
    "run_task",
    {
      description:
        "ORCHESTRATED + MUTATING: run a full execute → git-evidence → verify → auto-fix loop " +
        "server-side and return structured evidence (attempts, changed files, diff, verify output). " +
        "Same approval bar as execute_task: only after the user approved a plan. " +
        "Prefer this over execute_task when a test/build command can verify the work. " +
        "Note: cancel_task on a background run_task marks the job cancelled but does not kill " +
        "in-flight grok sub-processes (v1 limitation).",
      inputSchema: {
        ...commonShape,
        verify_command: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Shell command run in cwd after execution (e.g. 'npm test'). Omitted → git evidence only.",
          ),
        max_fix_attempts: z
          .number()
          .int()
          .min(0)
          .max(5)
          .optional()
          .describe("Auto-fix rounds when verify_command fails (default 2; 0 disables)"),
        verify_timeout_sec: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Timeout in seconds for each verify_command run (default 300)"),
        session_id: z
          .string()
          .uuid()
          .optional()
          .describe("Optional UUID to create/resume a named Grok session"),
      },
    },
    async (args, extra) => {
      const report = makeProgressReporter(extra);
      const cwd = normalizeCwd(args.cwd);
      const loopOpts = {
        prompt: args.prompt,
        cwd,
        verifyCommand: args.verify_command,
        maxFixAttempts: args.max_fix_attempts,
        verifyTimeoutSec: args.verify_timeout_sec,
        sessionId: args.session_id,
        model: args.model,
        maxTurns: args.max_turns,
        timeoutSec: args.timeout_sec,
      };

      if (args.background) {
        const job = await createJob({
          mode: "execute",
          prompt: args.prompt,
          cwd,
          sessionId: args.session_id,
        });
        void runTaskLoop({
          ...loopOpts,
          onProgress: (line) => void appendJobLog(job.id, line + "\n"),
          onEvent: (ev) => void appendJobLog(job.id, formatEvent(ev) + "\n"),
        })
          .then(async (result) => {
            if (getJob(job.id)?.state === "cancelled") return;
            await appendJobLog(
              job.id,
              "\n---\nresult:\n" + JSON.stringify(result, null, 2) + "\n",
            );
            await updateJob(job.id, {
              state: result.ok ? "completed" : "failed",
              finishedAt: new Date().toISOString(),
              exitCode: result.ok ? 0 : 1,
              sessionId: result.sessionId,
              error: result.error,
            });
          })
          .catch(async (err) => {
            await updateJob(job.id, {
              state: "failed",
              finishedAt: new Date().toISOString(),
              error: err instanceof Error ? err.message : String(err),
            });
          });
        return textResult({
          ok: true,
          jobId: job.id,
          logPath: job.logPath,
          summary: `Background run_task started: ${job.id}. Poll with task_status; tail -f the logPath for the live feed.`,
        });
      }

      const result = await runTaskLoop({
        ...loopOpts,
        onProgress: report,
        onEvent: report ? (ev) => report(formatEvent(ev)) : undefined,
      });
      return textResult(result, !result.ok);
    },
  );

  server.registerTool(
    "task_status",
    {
      description:
        "Poll a background job started with background=true, or list recent jobs if job_id is omitted.",
      inputSchema: {
        job_id: z
          .string()
          .uuid()
          .optional()
          .describe(
            "Job id returned by execute_task/review_task with background=true",
          ),
        include_log: z
          .boolean()
          .optional()
          .describe("Include truncated log tail (default true when job_id set)"),
      },
    },
    async (args) => {
      if (!args.job_id) {
        return textResult({ jobs: listJobs().slice(0, 20) });
      }
      const job = getJob(args.job_id);
      if (!job) {
        return textResult(
          { ok: false, error: `Unknown job_id: ${args.job_id}` },
          true,
        );
      }
      const includeLog = args.include_log !== false;
      const log = includeLog ? await readJobLog(args.job_id) : undefined;
      return textResult({
        ok: true,
        job,
        log: log?.text,
      });
    },
  );

  server.registerTool(
    "cancel_task",
    {
      description: "Cancel a running background Grok job by job_id.",
      inputSchema: {
        job_id: z.string().uuid().describe("Background job id to cancel"),
      },
    },
    async (args) => {
      const result = cancelJob(args.job_id);
      return textResult(result, !result.ok);
    },
  );
}
