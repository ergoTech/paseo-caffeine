import { test } from "node:test";
import assert from "node:assert/strict";
import { type SleepEvent, type SleepPhase, isSleepInFlight, nextSleepPhase } from "./sleep-phase.ts";

/** Feeds a run of events through, the way the surface would over a few seconds. */
function run(from: SleepPhase, ...events: SleepEvent["type"][]): SleepPhase {
  return events.reduce<SleepPhase>((phase, type) => nextSleepPhase(phase, { type } as SleepEvent), from);
}

test("the ordinary run: press, answered, silence", () => {
  assert.equal(run("idle", "press"), "asking");
  assert.equal(run("idle", "press", "answered"), "going");
  assert.equal(run("idle", "press", "answered", "silence"), "asleep");
});

test("a Mac that suspends before answering still reads as asleep", () => {
  // The reply is given a second's head start, but a slow network can lose the race.
  assert.equal(run("idle", "press", "silence"), "asleep");
});

test("a refused request puts the tile straight back", () => {
  assert.equal(run("idle", "press", "refused"), "idle");
});

test("silence when nothing was asked is not a sleep", () => {
  // A closed lid, a switched network, a daemon restarted by somebody else. The tile did
  // not cause it and must not claim it.
  assert.equal(run("idle", "silence"), "idle");
  assert.equal(run("asleep", "silence"), "asleep");
});

test("an answer during the countdown is just an overlapping poll", () => {
  // The five-second poll and the one-second delay overlap constantly; a status landing
  // mid-countdown says nothing about whether the Mac went under.
  assert.equal(run("idle", "press", "answered", "answer"), "going");
});

test("an answer after the silence means the Mac came back", () => {
  assert.equal(run("idle", "press", "answered", "silence", "answer"), "idle");
});

test("a sleep that never happened releases the tile on its own", () => {
  // Nothing suspends and the Mac keeps answering: the tile cannot stay lit for ever.
  assert.equal(run("idle", "press", "answered", "timeout"), "idle");
  // But a timeout is never allowed to overwrite a confirmed sleep.
  assert.equal(run("idle", "press", "answered", "silence", "timeout"), "asleep");
});

test("pressing again from any phase starts over", () => {
  assert.equal(run("asleep", "press"), "asking");
  assert.equal(run("going", "press"), "asking");
});

test("the bar shows while the request is out, and not after", () => {
  assert.equal(isSleepInFlight("idle"), false);
  assert.equal(isSleepInFlight("asking"), true);
  assert.equal(isSleepInFlight("going"), true);
  assert.equal(isSleepInFlight("asleep"), false);
});
