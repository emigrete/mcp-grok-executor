import { test } from "node:test";
import assert from "node:assert/strict";
import { makeProgressReporter, type ToolExtra } from "./tools.js";

function fakeExtra(
  token: string | undefined,
  sent: string[],
): ToolExtra {
  return {
    _meta: token === undefined ? {} : { progressToken: token },
    sendNotification: async (n: {
      params: { message?: string };
    }) => {
      sent.push(n.params.message ?? "");
    },
  } as unknown as ToolExtra;
}

test("returns undefined when client sent no progressToken", () => {
  const r = makeProgressReporter(fakeExtra(undefined, []));
  assert.equal(r, undefined);
});

test("throttles normal lines; important lines always go out", async () => {
  const sent: string[] = [];
  const report = makeProgressReporter(fakeExtra("t1", sent), 60_000)!;
  report("a"); // first → sent
  report("b"); // within throttle window → dropped
  report("c", true); // important → sent
  await new Promise((r) => setTimeout(r, 10)); // let async sends settle
  assert.deepEqual(sent, ["a", "c"]);
});

test("truncates messages to 300 chars", async () => {
  const sent: string[] = [];
  const report = makeProgressReporter(fakeExtra("t1", sent))!;
  report("y".repeat(500));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent[0]?.length, 300);
});
