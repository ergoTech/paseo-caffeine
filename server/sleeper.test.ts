import { test } from "node:test";
import assert from "node:assert/strict";
import { createSleeper } from "./sleeper.server.ts";

/**
 * Waits for the promise chain inside the sleeper to finish, however many links it has.
 * Counting microtasks here was a trap: adding one `.then()` to the implementation broke
 * two tests that were otherwise still describing the truth.
 */
const settled = () => new Promise((resolve) => setImmediate(resolve));

/** A schedule that hands back the pending callback instead of waiting for a clock. */
function manualSchedule() {
  const pending: Array<{ fn: () => void; ms: number }> = [];
  return {
    schedule: (fn: () => void, ms: number) => void pending.push({ fn, ms }),
    run: () => {
      const next = pending.shift();
      next?.fn();
    },
    get delays() {
      return pending.map((entry) => entry.ms);
    },
  };
}

test("the request returns before the Mac is asked to sleep", () => {
  const clock = manualSchedule();
  const calls: string[][] = [];
  const sleeper = createSleeper({
    delayMs: 1_000,
    schedule: clock.schedule,
    run: async (command, args) => void calls.push([command, ...args]),
  });

  sleeper.request();
  // Nothing has run yet: the reply to the phone has to leave the machine first.
  assert.deepEqual(calls, []);
  assert.deepEqual(clock.delays, [1_000]);

  clock.run();
  assert.deepEqual(calls, [["/usr/bin/pmset", "sleepnow"]]);
});

test("a pmset that fails leaves its reason behind", async () => {
  const clock = manualSchedule();
  const sleeper = createSleeper({
    schedule: clock.schedule,
    run: () => Promise.reject(new Error("pmset: unable to sleep")),
  });

  sleeper.request();
  clock.run();
  await settled();
  assert.equal(sleeper.error(), "pmset: unable to sleep");
});

test("a fresh request clears the last failure", async () => {
  const clock = manualSchedule();
  let fail = true;
  const sleeper = createSleeper({
    schedule: clock.schedule,
    run: () => (fail ? Promise.reject(new Error("nope")) : Promise.resolve()),
  });

  sleeper.request();
  clock.run();
  await settled();
  assert.equal(sleeper.error(), "nope");

  fail = false;
  sleeper.request();
  assert.equal(sleeper.error(), "", "the stale reason goes as soon as another try begins");
  clock.run();
  await settled();
  assert.equal(sleeper.error(), "");
});
