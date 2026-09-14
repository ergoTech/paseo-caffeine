import { test } from "node:test";
import assert from "node:assert/strict";
import { createController } from "./controller.server.ts";
import type { Keeper } from "./keeper.server.ts";
import type { Stored } from "./policy.ts";
import { GRACE_MS } from "./policy.ts";

function fakes(initial: Stored, running: () => number | null) {
  let stored = initial;
  const writes: Stored[] = [];
  const held: Array<number | undefined> = [];
  const heldDisplay: boolean[] = [];
  let releases = 0;
  let active = false;
  let clock = Date.parse("2026-09-09T18:00:00.000Z");
  const keeper: Keeper = {
    active: () => active,
    error: () => "",
    pid: () => (active ? 1 : null),
    hold: (until, keepDisplay = false) => {
      active = true;
      held.push(until);
      heldDisplay.push(keepDisplay);
    },
    release: () => {
      if (active) releases += 1;
      active = false;
    },
  };
  const controller = createController({
    read: async () => stored,
    write: async (next) => {
      stored = next;
      writes.push(next);
    },
    keeper,
    runningCount: async () => running(),
    now: () => clock,
    tickMs: 60 * 60_000, // never fires during a test
  });
  return {
    controller,
    keeper,
    writes,
    held,
    heldDisplay,
    releaseCount: () => releases,
    advance: (ms: number) => (clock += ms),
    get stored() {
      return stored;
    },
  };
}

test("start restores a stored 'on' and holds at once", async () => {
  const f = fakes({ mode: "on", until: "", keepDisplay: false }, () => 0);
  await f.controller.start();
  assert.equal(f.keeper.active(), true);
  assert.equal(f.controller.status().mode, "on");
  f.controller.stop();
  assert.equal(f.keeper.active(), false);
});

test("set timer writes the deadline and holds with it", async () => {
  const f = fakes({ mode: "off", until: "", keepDisplay: false }, () => 0);
  await f.controller.start();
  const status = await f.controller.set({ mode: "timer", minutes: 180 });
  assert.equal(status.mode, "timer");
  assert.equal(status.until, "2026-09-09T21:00:00.000Z");
  assert.equal(f.held.at(-1), Date.parse("2026-09-09T21:00:00.000Z"));
  assert.equal(f.stored.mode, "timer");
  f.controller.stop();
});

test("a tick past the deadline turns the timer off and releases", async () => {
  const f = fakes({ mode: "timer", until: "2026-09-09T18:00:30.000Z", keepDisplay: false }, () => 0);
  await f.controller.start();
  assert.equal(f.keeper.active(), true);
  f.advance(31_000);
  const status = await f.controller.tick();
  assert.equal(status.mode, "off");
  assert.equal(status.active, false);
  assert.equal(f.stored.mode, "off");
  f.controller.stop();
});

test("auto holds while agents run and releases after the grace period", async () => {
  let running: number | null = 2;
  const f = fakes({ mode: "auto", until: "", keepDisplay: false }, () => running);
  await f.controller.start();
  assert.equal(f.keeper.active(), true);
  assert.equal(f.controller.status().agents, 2);
  running = 0;
  f.advance(60_000);
  await f.controller.tick();
  assert.equal(f.keeper.active(), true, "still inside grace");
  f.advance(GRACE_MS);
  await f.controller.tick();
  assert.equal(f.keeper.active(), false);
  f.controller.stop();
});

test("auto with no answer yet stays released and says so", async () => {
  const f = fakes({ mode: "auto", until: "", keepDisplay: false }, () => null);
  await f.controller.start();
  assert.equal(f.keeper.active(), false);
  assert.equal(f.controller.status().busy, false);
  assert.equal(f.controller.status().agents, 0);
  f.controller.stop();
});

test("set off releases and writes", async () => {
  const f = fakes({ mode: "on", until: "", keepDisplay: false }, () => 0);
  await f.controller.start();
  const status = await f.controller.set({ mode: "off" });
  assert.equal(status.active, false);
  assert.equal(f.keeper.active(), false);
  assert.deepEqual(f.writes.at(-1), { mode: "off", until: "", keepDisplay: false });
  f.controller.stop();
});

test("switching on to timer restarts the child with a deadline", async () => {
  const f = fakes({ mode: "on", until: "", keepDisplay: false }, () => 0);
  await f.controller.start();
  assert.equal(f.held.at(-1), undefined);
  await f.controller.set({ mode: "timer", minutes: 60 });
  assert.equal(f.held.at(-1), Date.parse("2026-09-09T19:00:00.000Z"));
  f.controller.stop();
});

test("the display switch reaches the child and is written down", async () => {
  const f = fakes({ mode: "on", until: "", keepDisplay: false }, () => 0);
  await f.controller.start();
  assert.equal(f.heldDisplay.at(-1), false);

  const status = await f.controller.setDisplay(true);
  assert.equal(status.keepDisplay, true);
  assert.equal(f.heldDisplay.at(-1), true);
  assert.deepEqual(f.writes.at(-1), { mode: "on", until: "", keepDisplay: true });
  f.controller.stop();
});

test("changing the display choice restarts the child, because caffeinate cannot be retold", async () => {
  const f = fakes({ mode: "on", until: "", keepDisplay: false }, () => 0);
  await f.controller.start();
  const before = f.releaseCount();
  await f.controller.setDisplay(true);
  assert.equal(f.releaseCount(), before + 1);
  assert.equal(f.keeper.active(), true);
  f.controller.stop();
});

test("setting the display to what it already is neither writes nor restarts", async () => {
  const f = fakes({ mode: "on", until: "", keepDisplay: true }, () => 0);
  await f.controller.start();
  const writes = f.writes.length;
  const releases = f.releaseCount();
  await f.controller.setDisplay(true);
  assert.equal(f.writes.length, writes);
  assert.equal(f.releaseCount(), releases);
  f.controller.stop();
});

test("a mode change carries the display choice with it", async () => {
  const f = fakes({ mode: "on", until: "", keepDisplay: true }, () => 0);
  await f.controller.start();
  await f.controller.set({ mode: "timer", minutes: 60 });
  assert.equal(f.stored.keepDisplay, true);
  assert.equal(f.heldDisplay.at(-1), true);
  f.controller.stop();
});

test("the battery is read once a tick and reaches the status", async () => {
  const f = fakes({ mode: "off", until: "", keepDisplay: false }, () => 0);
  let reads = 0;
  const controller = createController({
    read: async () => ({ mode: "off", until: "", keepDisplay: false }),
    write: async () => undefined,
    keeper: f.keeper,
    runningCount: async () => 0,
    readBattery: async () => {
      reads += 1;
      return { percent: 42, charging: true, charged: false, external: true, minutes: 90 };
    },
    tickMs: 60 * 60_000,
  });
  await controller.start();
  assert.equal(reads, 1);
  assert.equal(controller.status().battery?.percent, 42);
  await controller.tick();
  assert.equal(reads, 2);
  controller.stop();
});

test("a controller with no battery probe simply has none", async () => {
  const f = fakes({ mode: "off", until: "", keepDisplay: false }, () => 0);
  await f.controller.start();
  assert.equal(f.controller.status().battery, null);
  f.controller.stop();
});

test("a half-hour timer lands thirty minutes out", async () => {
  const f = fakes({ mode: "off", until: "", keepDisplay: false }, () => 0);
  await f.controller.start();
  const status = await f.controller.set({ mode: "timer", minutes: 30 });
  assert.equal(status.until, "2026-09-09T18:30:00.000Z");
  assert.equal(f.held.at(-1), Date.parse("2026-09-09T18:30:00.000Z"));
  f.controller.stop();
});
