#!/usr/bin/env node
// Test double for the grok CLI: ignores args, emits a fixed streaming-json
// conversation on stdout, exits 0. Used by src/grokRunner.test.ts.
// FAKE_GROK_MODE=slow: emit thought, wait 5s, then the rest (for abort tests).
// FAKE_GROK_MODE=plain: print non-JSON stdout only (no NDJSON stream events).
const events = [
  { type: "thought", data: "planning" },
  { type: "text", data: "All " },
  { type: "text", data: "done." },
  {
    type: "end",
    stopReason: "EndTurn",
    sessionId: "11111111-1111-4111-8111-111111111111",
    num_turns: 1,
    usage: { total_tokens: 42 },
  },
];

async function main() {
  if (process.env.FAKE_GROK_MODE === "plain") {
    process.stdout.write("Plain non-JSON output.\n");
    process.exit(0);
  }
  if (process.env.FAKE_GROK_MODE === "slow") {
    process.stdout.write(JSON.stringify(events[0]) + "\n");
    await new Promise((r) => setTimeout(r, 5000));
    for (const ev of events.slice(1)) {
      process.stdout.write(JSON.stringify(ev) + "\n");
    }
  } else {
    for (const ev of events) process.stdout.write(JSON.stringify(ev) + "\n");
  }
  process.exit(0);
}

main();
