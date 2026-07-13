import { test } from "node:test";
import assert from "node:assert/strict";
import { tryAcquire, currentHolder } from "./locks.js";

test("acquire succeeds and records holder", () => {
  const cwd = "/tmp/lock-test-acquire-" + Math.random();
  const lock = tryAcquire(cwd, "holder-a");
  assert.ok(lock);
  assert.equal(currentHolder(cwd), "holder-a");
  lock!.release();
});

test("second acquire on same cwd returns null", () => {
  const cwd = "/tmp/lock-test-second-" + Math.random();
  const lock = tryAcquire(cwd, "first");
  assert.ok(lock);
  assert.equal(tryAcquire(cwd, "second"), null);
  assert.equal(currentHolder(cwd), "first");
  lock!.release();
});

test("release makes cwd re-acquirable", () => {
  const cwd = "/tmp/lock-test-release-" + Math.random();
  const first = tryAcquire(cwd, "first");
  assert.ok(first);
  first!.release();
  assert.equal(currentHolder(cwd), undefined);
  const second = tryAcquire(cwd, "second");
  assert.ok(second);
  assert.equal(currentHolder(cwd), "second");
  second!.release();
});

test("release is idempotent; stale release does not free new holder", () => {
  const cwd = "/tmp/lock-test-stale-" + Math.random();
  const old = tryAcquire(cwd, "old");
  assert.ok(old);
  old!.release();
  old!.release(); // double release is fine

  const neu = tryAcquire(cwd, "new");
  assert.ok(neu);
  assert.equal(currentHolder(cwd), "new");

  // Stale handle must NOT free the new holder
  old!.release();
  assert.equal(currentHolder(cwd), "new");

  neu!.release();
  assert.equal(currentHolder(cwd), undefined);
});

test("setHolder updates currentHolder", () => {
  const cwd = "/tmp/lock-test-setholder-" + Math.random();
  const lock = tryAcquire(cwd, "starting");
  assert.ok(lock);
  lock!.setHolder("running");
  assert.equal(currentHolder(cwd), "running");
  lock!.release();
  // After release, setHolder is a no-op
  lock!.setHolder("ghost");
  assert.equal(currentHolder(cwd), undefined);
});

test("different cwds do not collide", () => {
  const a = "/tmp/lock-test-a-" + Math.random();
  const b = "/tmp/lock-test-b-" + Math.random();
  const la = tryAcquire(a, "A");
  const lb = tryAcquire(b, "B");
  assert.ok(la);
  assert.ok(lb);
  assert.equal(currentHolder(a), "A");
  assert.equal(currentHolder(b), "B");
  la!.release();
  assert.equal(currentHolder(a), undefined);
  assert.equal(currentHolder(b), "B");
  lb!.release();
});
