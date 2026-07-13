/**
 * Line-buffered parser for `grok --output-format streaming-json` (NDJSON).
 * Verified event types: {"type":"thought"|"text","data":"<token>"} deltas and
 * a terminal {"type":"end",...}. Token deltas are aggregated into readable
 * chunks: flushed on kind switch, embedded newline, or FLUSH_CHARS length.
 */
export type GrokStreamEvent =
  | { kind: "thought"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; status: string; detail?: string }
  | {
      kind: "end";
      sessionId?: string;
      stopReason?: string;
      numTurns?: number;
      totalTokens?: number;
    }
  | { kind: "raw"; line: string };

const FLUSH_CHARS = 160;

/** Accumulates thought/text deltas; flushes on kind switch, newline, or length. */
export class DeltaAggregator {
  private accumKind: "thought" | "text" | null = null;
  private accum = "";

  push(kind: "thought" | "text", data: string): GrokStreamEvent[] {
    const out: GrokStreamEvent[] = [];
    if (this.accumKind !== null && this.accumKind !== kind) this.emitAccum(out);
    this.accumKind = kind;
    this.accum += data;
    if (this.accum.includes("\n") || this.accum.length >= FLUSH_CHARS) {
      this.emitAccum(out);
    }
    return out;
  }

  flush(): GrokStreamEvent[] {
    const out: GrokStreamEvent[] = [];
    this.emitAccum(out);
    return out;
  }

  private emitAccum(out: GrokStreamEvent[]): void {
    if (this.accumKind !== null && this.accum.length > 0) {
      out.push({ kind: this.accumKind, text: this.accum });
    }
    this.accumKind = null;
    this.accum = "";
  }
}

export class StreamParser {
  private lineBuf = "";
  private readonly deltas = new DeltaAggregator();

  push(chunk: string): GrokStreamEvent[] {
    const out: GrokStreamEvent[] = [];
    this.lineBuf += chunk;
    let idx: number;
    while ((idx = this.lineBuf.indexOf("\n")) !== -1) {
      const line = this.lineBuf.slice(0, idx).trim();
      this.lineBuf = this.lineBuf.slice(idx + 1);
      if (line) this.consumeLine(line, out);
    }
    return out;
  }

  /** Call once after the stream closes: drains partial line + accumulation. */
  flush(): GrokStreamEvent[] {
    const out: GrokStreamEvent[] = [];
    const rest = this.lineBuf.trim();
    this.lineBuf = "";
    if (rest) this.consumeLine(rest, out);
    out.push(...this.deltas.flush());
    return out;
  }

  private consumeLine(line: string, out: GrokStreamEvent[]): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      out.push(...this.deltas.flush());
      out.push({ kind: "raw", line });
      return;
    }
    const type = parsed.type;
    if ((type === "thought" || type === "text") && typeof parsed.data === "string") {
      out.push(...this.deltas.push(type, parsed.data));
      return;
    }
    if (type === "end") {
      out.push(...this.deltas.flush());
      const usage = (parsed.usage ?? {}) as Record<string, unknown>;
      out.push({
        kind: "end",
        sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
        stopReason: typeof parsed.stopReason === "string" ? parsed.stopReason : undefined,
        numTurns: typeof parsed.num_turns === "number" ? parsed.num_turns : undefined,
        totalTokens:
          typeof usage.total_tokens === "number" ? usage.total_tokens : undefined,
      });
      return;
    }
    out.push(...this.deltas.flush());
    out.push({ kind: "raw", line });
  }
}

/** Human-readable one-liner for job logs and progress notifications. */
export function formatEvent(ev: GrokStreamEvent): string {
  switch (ev.kind) {
    case "thought":
      return `[thought] ${ev.text.trim()}`;
    case "text":
      return `[grok] ${ev.text.trim()}`;
    case "tool":
      return `[tool] ${ev.name} (${ev.status})` + (ev.detail != null ? ` — ${ev.detail}` : "");
    case "end":
      return `[end] session=${ev.sessionId ?? "?"} stop=${ev.stopReason ?? "?"} turns=${ev.numTurns ?? "?"} tokens=${ev.totalTokens ?? "?"}`;
    case "raw":
      return `[raw] ${ev.line}`;
  }
}
