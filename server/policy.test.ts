import { test } from "node:test";
import assert from "node:assert/strict";
import { GRACE_MS, decide, defaultStored, nextBusyUntil, untilForHours } from "./policy.ts";

const NOW = Date.parse("2026-09-09T18:00:00.000Z");

test("off is never active", () => {
  const decision = decide({ mode: "off", until: "" }, NOW, NOW + GRACE_MS);
  assert.equal(decision.active, false);
  assert.equal(decision.stored.mode, "off");
});

test("on is active regardless of agents", () => {
  const decision = decide({ mode: "on", until: "" }, NOW, 0);
  assert.equal(decision.active, true);
});

test("timer is active until its deadline", () => {
  const until = new Date(NOW + 60_000).toISOString();
  const decision = decide({ mode: "timer", until }, NOW, 0);
  assert.equal(decision.active, true);
  assert.equal(decision.stored.mode, "timer");
});

test("an expired timer turns itself off", () => {
  const until = new Date(NOW - 1).toISOString();
  const decision = decide({ mode: "timer", until }, NOW, 0);
  assert.equal(decision.active, false);
  assert.deepEqual(decision.stored, { mode: "off", until: "" });
  assert.match(decision.reason, /expired/);
});

test("a timer with an unreadable deadline turns itself off", () => {
  const decision = decide({ mode: "timer", until: "not a date" }, NOW, 0);
  assert.equal(decision.active, false);
  assert.equal(decision.stored.mode, "off");
});

test("auto is active while the busy window is open", () => {
  assert.equal(decide({ mode: "auto", until: "" }, NOW, NOW + 1).active, true);
  assert.equal(decide({ mode: "auto", until: "" }, NOW, NOW).active, false);
});

test("running agents push the busy window a full grace period ahead", () => {
  assert.equal(nextBusyUntil(0, 2, NOW), NOW + GRACE_MS);
});

test("no running agents leave the window where it was", () => {
  assert.equal(nextBusyUntil(NOW + 1000, 0, NOW), NOW + 1000);
});

test("an unknown answer leaves the window where it was", () => {
  assert.equal(nextBusyUntil(NOW + 1000, null, NOW), NOW + 1000);
});

test("untilForHours is RFC 3339, hours ahead", () => {
  assert.equal(untilForHours(NOW, 3), new Date(NOW + 3 * 3_600_000).toISOString());
});

test("the default is off", () => {
  assert.deepEqual(defaultStored(), { mode: "off", until: "" });
});
