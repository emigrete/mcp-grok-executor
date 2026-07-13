import { spawn, type ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { config } from "./config.js";
import { checkGrokAuth } from "./auth.js";
import { createJob } from "./jobs.js";
import {
  DeltaAggregator,
  formatEvent,
  type GrokStreamEvent,
} from "./streamEvents.js";
import type { GrokTransport } from "./transport.js";
import type { GrokRunOptions, GrokRunResult } from "./grokRunner.js";

type JsonRpcMsg = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
};

function truncate(text: string, max = config.maxOutputChars): string {
  if (text.length <= max) return text;
  return (
    text.slice(0, max) +
    `\n\n…[truncated ${text.length - max} chars; see log file if available]`
  );
}

function truncateStr(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

function pickDetail(raw: unknown): string | undefined {
  if (raw == null || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const v = r.file_path ?? r.command ?? r.path;
  if (typeof v !== "string") return undefined;
  return truncateStr(v, 120);
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

function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9_./:@%+=,-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * ACP transport: one `grok agent stdio` process per run, JSON-RPC 2.0
 * newline-delimited, with real tool-call visibility via session/update.
 */
async function acpRun(opts: GrokRunOptions): Promise<GrokRunResult> {
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

  const timeoutSec = opts.timeoutSec ?? config.defaultTimeoutSec;
  const command = [config.grokBin, "agent", "stdio"];
  const child = spawn(config.grokBin, ["agent", "stdio"], {
    cwd: opts.cwd,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });

  let settled = false;
  let stderr = "";
  let finalText = "";
  let sessionId: string | undefined;
  const logLines: string[] = [];
  const aggregator = new DeltaAggregator();
  /** toolCallId → title from tool_call events (updates often omit title) */
  const toolTitles = new Map<string, string>();
  let nextId = 1;
  const pending = new Map<
    number | string,
    { resolve: (msg: JsonRpcMsg) => void }
  >();

  const emit = (ev: GrokStreamEvent): void => {
    logLines.push(formatEvent(ev));
    opts.onEvent?.(ev);
  };
  const emitAll = (evs: GrokStreamEvent[]): void => {
    for (const ev of evs) emit(ev);
  };

  const send = (obj: Record<string, unknown>): void => {
    try {
      child.stdin?.write(JSON.stringify(obj) + "\n");
    } catch {
      /* process may already be dead */
    }
  };

  const request = (method: string, params: unknown): Promise<unknown> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, {
        resolve: (msg) => {
          if (msg.error) {
            reject(
              new Error(
                msg.error.message ?? `JSON-RPC error on ${method}`,
              ),
            );
          } else {
            resolve(msg.result);
          }
        },
      });
      send({ jsonrpc: "2.0", id, method, params });
    });
  };

  const respond = (id: number | string, result: unknown): void => {
    send({ jsonrpc: "2.0", id, result });
  };

  const respondError = (
    id: number | string,
    code: number,
    message: string,
  ): void => {
    send({ jsonrpc: "2.0", id, error: { code, message } });
  };

  const handleUpdate = (update: Record<string, unknown>): void => {
    const kind = update.sessionUpdate;
    if (kind === "agent_thought_chunk") {
      const content = update.content as { text?: string } | undefined;
      if (typeof content?.text === "string") {
        emitAll(aggregator.push("thought", content.text));
      }
      return;
    }
    if (kind === "agent_message_chunk") {
      const content = update.content as { text?: string } | undefined;
      if (typeof content?.text === "string") {
        finalText += content.text;
        emitAll(aggregator.push("text", content.text));
      }
      return;
    }
    if (kind === "tool_call") {
      emitAll(aggregator.flush());
      const name = truncateStr(String(update.title ?? "tool"), 80);
      if (typeof update.toolCallId === "string") {
        toolTitles.set(update.toolCallId, name);
      }
      emit({
        kind: "tool",
        name,
        status: "started",
        detail: pickDetail(update.rawInput),
      });
      return;
    }
    if (kind === "tool_call_update") {
      emitAll(aggregator.flush());
      const toolCallId =
        typeof update.toolCallId === "string" ? update.toolCallId : undefined;
      const name = truncateStr(
        String(
          update.title ??
            (toolCallId !== undefined ? toolTitles.get(toolCallId) : undefined) ??
            "tool",
        ),
        80,
      );
      const content = update.content as Array<{ path?: string }> | undefined;
      const path = content?.[0]?.path;
      emit({
        kind: "tool",
        name,
        status: String(update.status ?? update.kind ?? "update"),
        detail: typeof path === "string" ? truncateStr(path, 120) : undefined,
      });
      return;
    }
    // user_message_chunk / available_commands_update / unknown → ignore
  };

  const handleMsg = (msg: JsonRpcMsg): void => {
    // Response to one of our requests
    if (
      msg.id !== undefined &&
      (msg.result !== undefined || msg.error !== undefined) &&
      pending.has(msg.id)
    ) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      p.resolve(msg);
      return;
    }
    // Notification
    if (msg.method === "session/update") {
      const params = msg.params as { update?: Record<string, unknown> } | undefined;
      if (params?.update) handleUpdate(params.update);
      return;
    }
    // Agent → client request
    if (msg.method && msg.id !== undefined) {
      if (msg.method === "session/request_permission") {
        const params = msg.params as {
          options?: Array<{ optionId?: string; name?: string }>;
        } | null;
        const options = params?.options ?? [];
        const allow =
          options.find(
            (o) =>
              /allow/i.test(o.optionId ?? "") || /allow/i.test(o.name ?? ""),
          ) ?? options[0];
        respond(msg.id, {
          outcome: { outcome: "selected", optionId: allow?.optionId },
        });
        return;
      }
      respondError(msg.id, -32601, "unhandled");
    }
  };

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");

  let lineBuf = "";
  child.stdout?.on("data", (d: string) => {
    lineBuf += d;
    let idx: number;
    while ((idx = lineBuf.indexOf("\n")) !== -1) {
      const line = lineBuf.slice(0, idx).trim();
      lineBuf = lineBuf.slice(idx + 1);
      if (!line) continue;
      try {
        handleMsg(JSON.parse(line) as JsonRpcMsg);
      } catch {
        /* ignore malformed lines */
      }
    }
  });
  child.stderr?.on("data", (d: string) => {
    stderr += d;
  });

  const baseResult = (): Omit<
    GrokRunResult,
    "ok" | "exitCode" | "summary" | "error" | "sessionId" | "usage" | "logPath" | "jobId"
  > => ({
    mode: opts.mode,
    durationMs: Date.now() - started,
    cwd: opts.cwd,
    stdout: truncate(finalText),
    stderr: truncate(stderr),
    command,
    authOk: true,
  });

  return new Promise<GrokRunResult>((resolve) => {
    const settle = async (
      partial: Pick<GrokRunResult, "ok" | "exitCode" | "summary"> &
        Partial<
          Pick<GrokRunResult, "error" | "sessionId" | "usage" | "stdout" | "stderr">
        >,
    ): Promise<void> => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);

      for (const [, p] of pending) {
        p.resolve({ error: { message: partial.error ?? "cancelled" } });
      }
      pending.clear();

      killTree(child, "SIGTERM");
      setTimeout(() => {
        killTree(child, "SIGKILL");
      }, 2000).unref();

      const summary =
        partial.summary ||
        finalText.trim() ||
        "(no output)";
      let logPath: string | undefined;
      let jobId: string | undefined;
      try {
        const job = await createJob({
          mode: opts.mode,
          prompt: opts.prompt,
          cwd: opts.cwd,
          sessionId: partial.sessionId ?? sessionId,
          state: partial.ok ? "completed" : "failed",
          finishedAt: new Date().toISOString(),
          exitCode: partial.exitCode,
          pid: child.pid,
          error: partial.error,
        });
        logPath = job.logPath;
        jobId = job.id;
        await writeFile(
          job.logPath,
          `COMMAND: ${command.map(shellQuote).join(" ")}\n\n` +
            logLines.join("\n") +
            (logLines.length ? "\n" : "") +
            (stderr ? `\n--- STDERR ---\n${stderr}\n` : ""),
          "utf8",
        );
      } catch {
        /* non-fatal */
      }

      resolve({
        ...baseResult(),
        ok: partial.ok,
        exitCode: partial.exitCode,
        summary: truncate(summary),
        stdout: partial.stdout !== undefined ? truncate(partial.stdout) : truncate(finalText),
        stderr: partial.stderr !== undefined ? truncate(partial.stderr) : truncate(stderr),
        sessionId: partial.sessionId ?? sessionId,
        usage: partial.usage,
        error: partial.error,
        logPath,
        jobId,
        durationMs: Date.now() - started,
      });
    };

    const onAbort = (): void => {
      void settle({
        ok: false,
        exitCode: null,
        summary: "cancelled",
        error: "cancelled",
      });
    };

    const timer = setTimeout(() => {
      void settle({
        ok: false,
        exitCode: null,
        summary: `Timeout after ${timeoutSec}s`,
        error: `Timeout after ${timeoutSec}s`,
      });
    }, timeoutSec * 1000);

    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (err) => {
      stderr += `\n[spawn error] ${err.message}`;
      void settle({
        ok: false,
        exitCode: null,
        summary: err.message,
        error: err.message,
      });
    });

    child.on("close", () => {
      if (settled) return;
      const tail = stderr.trim().slice(-500) || "agent process exited unexpectedly";
      void settle({
        ok: false,
        exitCode: null,
        summary: tail,
        error: tail,
      });
    });

    void (async () => {
      try {
        const initResult = (await request("initialize", {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
          },
        })) as {
          agentCapabilities?: { loadSession?: boolean };
        };

        const loadSession = initResult?.agentCapabilities?.loadSession === true;

        if (opts.sessionId && loadSession) {
          try {
            await request("session/load", {
              sessionId: opts.sessionId,
              cwd: opts.cwd,
              mcpServers: [],
            });
            sessionId = opts.sessionId;
          } catch {
            emit({
              kind: "raw",
              line: "[acp] session/load failed; started a fresh session",
            });
            const newSess = (await request("session/new", {
              cwd: opts.cwd,
              mcpServers: [],
            })) as { sessionId?: string };
            sessionId = newSess?.sessionId;
          }
        } else {
          const newSess = (await request("session/new", {
            cwd: opts.cwd,
            mcpServers: [],
          })) as { sessionId?: string };
          sessionId = newSess?.sessionId;
        }

        if (!sessionId) {
          await settle({
            ok: false,
            exitCode: null,
            summary: "ACP session/new did not return sessionId",
            error: "ACP session/new did not return sessionId",
          });
          return;
        }

        const promptResult = (await request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: opts.prompt }],
        })) as {
          stopReason?: string;
          _meta?: { usage?: { numTurns?: number; totalTokens?: number } };
        };

        emitAll(aggregator.flush());
        const stopReason = promptResult?.stopReason;
        const usage = promptResult?._meta?.usage;
        const numTurns = usage?.numTurns;
        const totalTokens = usage?.totalTokens;
        emit({
          kind: "end",
          sessionId,
          stopReason,
          numTurns,
          totalTokens,
        });

        const ok = stopReason === "end_turn";
        await settle({
          ok,
          exitCode: ok ? 0 : null,
          summary: finalText.trim() || "(no output)",
          sessionId,
          usage:
            numTurns !== undefined || totalTokens !== undefined
              ? { numTurns, totalTokens }
              : undefined,
          error: ok ? undefined : `stopReason: ${stopReason ?? "unknown"}`,
        });
      } catch (err) {
        if (settled) return;
        const message = err instanceof Error ? err.message : String(err);
        await settle({
          ok: false,
          exitCode: null,
          summary: message,
          error: message,
          sessionId,
        });
      }
    })();
  });
}

export const acpTransport: GrokTransport = { name: "acp", run: acpRun };
