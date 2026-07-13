import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamParser, formatEvent, DeltaAggregator } from "./streamEvents.js";

test("aggregates consecutive text deltas and parses end event", () => {
  const p = new StreamParser();
  const evs = [
    ...p.push('{"type":"text","data":"Hello "}\n{"type":"text","data":"world"}\n'),
    ...p.push(
      '{"type":"end","stopReason":"EndTurn","sessionId":"abc","num_turns":2,"usage":{"total_tokens":42}}\n',
    ),
    ...p.flush(),
  ];
  assert.deepEqual(evs, [
    { kind: "text", text: "Hello world" },
    { kind: "end", sessionId: "abc", stopReason: "EndTurn", numTurns: 2, totalTokens: 42 },
  ]);
});

test("emits accumulated text when kind switches", () => {
  const p = new StreamParser();
  const evs = [
    ...p.push('{"type":"thought","data":"hmm"}\n{"type":"text","data":"Hi"}\n'),
    ...p.flush(),
  ];
  assert.deepEqual(evs, [
    { kind: "thought", text: "hmm" },
    { kind: "text", text: "Hi" },
  ]);
});

test("handles JSON lines split across push() calls", () => {
  const p = new StreamParser();
  const evs = [...p.push('{"type":"text","da'), ...p.push('ta":"chunked"}\n'), ...p.flush()];
  assert.deepEqual(evs, [{ kind: "text", text: "chunked" }]);
});

test("malformed line becomes a raw event", () => {
  const p = new StreamParser();
  const evs = [...p.push("not json at all\n"), ...p.flush()];
  assert.deepEqual(evs, [{ kind: "raw", line: "not json at all" }]);
});

test("unknown event type becomes a raw event", () => {
  const p = new StreamParser();
  const evs = [...p.push('{"type":"mystery","data":"x"}\n'), ...p.flush()];
  assert.deepEqual(evs, [{ kind: "raw", line: '{"type":"mystery","data":"x"}' }]);
});

test("flushes accumulation once it reaches 160 chars", () => {
  const p = new StreamParser();
  const big = "x".repeat(200);
  const evs = p.push(`{"type":"text","data":"${big}"}\n`);
  assert.equal(evs.length, 1);
  assert.equal(evs[0]?.kind, "text");
});

test("flushes accumulation on embedded newline", () => {
  const p = new StreamParser();
  const evs = p.push('{"type":"text","data":"line one\\ntail"}\n');
  assert.equal(evs.length, 1);
  assert.equal(evs[0]?.kind, "text");
  assert.match((evs[0] as { text: string }).text, /line one\n/);
});

test("formatEvent labels each kind", () => {
  assert.equal(formatEvent({ kind: "text", text: " hi " }), "[grok] hi");
  assert.equal(formatEvent({ kind: "thought", text: "t" }), "[thought] t");
  assert.match(formatEvent({ kind: "end", sessionId: "s" }), /^\[end\] session=s/);
  assert.equal(formatEvent({ kind: "raw", line: "z" }), "[raw] z");
});

test("formatEvent formats tool events with and without detail", () => {
  assert.equal(
    formatEvent({ kind: "tool", name: "write", status: "started" }),
    "[tool] write (started)",
  );
  assert.equal(
    formatEvent({ kind: "tool", name: "write", status: "started", detail: "/path/foo.ts" }),
    "[tool] write (started) — /path/foo.ts",
  );
});

test("DeltaAggregator aggregates consecutive same-kind pushes and flushes on kind switch", () => {
  const a = new DeltaAggregator();
  assert.deepEqual(a.push("text", "Hello "), []);
  assert.deepEqual(a.push("text", "world"), []);
  assert.deepEqual(a.push("thought", "hmm"), [{ kind: "text", text: "Hello world" }]);
  assert.deepEqual(a.flush(), [{ kind: "thought", text: "hmm" }]);
});

test("DeltaAggregator flushes at 160 chars", () => {
  const a = new DeltaAggregator();
  const big = "x".repeat(200);
  const evs = a.push("text", big);
  assert.equal(evs.length, 1);
  assert.deepEqual(evs[0], { kind: "text", text: big });
  assert.deepEqual(a.flush(), []);
});

test("DeltaAggregator flush drains the remainder", () => {
  const a = new DeltaAggregator();
  assert.deepEqual(a.push("thought", "partial"), []);
  assert.deepEqual(a.flush(), [{ kind: "thought", text: "partial" }]);
  assert.deepEqual(a.flush(), []);
});
