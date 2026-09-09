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
  let active = false;
  let clock = Date.parse("2026-09-09T18:00:00.000Z");
  const keeper: Keeper = {
    active: () => active,
    error: () => "",
    pid: () => (active ? 1 : null),
    hold: (until) => {
      active = true;
      held.push(until);
    },
    release: () => {
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
    advance: (ms: number) => (clock += ms),
    get stored() {
      return stored;
    },
  };
}

test("start restores a stored 'on' and holds at once", async () => {
  const f = fakes({ mode: "on", until: "" }, () => 0);
  await f.controller.start();
  assert.equal(f.keeper.active(), true);
  assert.equal(f.controller.status().mode, "on");
  f.controller.stop();
  assert.equal(f.keeper.active(), false);
});

test("set timer writes the deadline and holds with it", async () => {
  const f = fakes({ mode: "off", until: "" }, () => 0);
  await f.controller.start();
  const status = await f.controller.set({ mode: "timer", hours: 3 });
  assert.equal(status.mode, "timer");
  assert.equal(status.until, "2026-09-09T21:00:00.000Z");
  assert.equal(f.held.at(-1), Date.parse("2026-09-09T21:00:00.000Z"));
  assert.equal(f.stored.mode, "timer");
  f.controller.stop();
});

test("a tick past the deadline turns the timer off and releases", async () => {
  const f = fakes({ mode: "timer", until: "2026-09-09T18:00:30.000Z" }, () => 0);
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
  const f = fakes({ mode: "auto", until: "" }, () => running);
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
  const f = fakes({ mode: "auto", until: "" }, () => null);
  await f.controller.start();
  assert.equal(f.keeper.active(), false);
  assert.equal(f.controller.status().busy, false);
  assert.equal(f.controller.status().agents, 0);
  f.controller.stop();
});

test("set off releases and writes", async () => {
  const f = fakes({ mode: "on", until: "" }, () => 0);
  await f.controller.start();
  const status = await f.controller.set({ mode: "off" });
  assert.equal(status.active, false);
  assert.equal(f.keeper.active(), false);
  assert.deepEqual(f.writes.at(-1), { mode: "off", until: "" });
  f.controller.stop();
});

test("switching on to timer restarts the child with a deadline", async () => {
  const f = fakes({ mode: "on", until: "" }, () => 0);
  await f.controller.start();
  assert.equal(f.held.at(-1), undefined);
  await f.controller.set({ mode: "timer", hours: 1 });
  assert.equal(f.held.at(-1), Date.parse("2026-09-09T19:00:00.000Z"));
  f.controller.stop();
});
