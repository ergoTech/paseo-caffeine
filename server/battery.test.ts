import { test } from "node:test";
import assert from "node:assert/strict";
import { createBatteryProbe, parseBattery } from "./battery.server.ts";

/** Copied from a MacBook Pro on the charger, tab and all. */
const CHARGED = `Now drawing from 'AC Power'
 -InternalBattery-0 (id=34930787)\t100%; charged; 0:00 remaining present: true
`;

const DISCHARGING = `Now drawing from 'Battery Power'
 -InternalBattery-0 (id=34930787)\t87%; discharging; 4:32 remaining present: true
`;

const CHARGING = `Now drawing from 'AC Power'
 -InternalBattery-0 (id=34930787)\t45%; charging; 1:23 remaining present: true
`;

const NO_ESTIMATE = `Now drawing from 'Battery Power'
 -InternalBattery-0 (id=34930787)\t61%; discharging; (no estimate) present: true
`;

const NOT_CHARGING = `Now drawing from 'AC Power'
 -InternalBattery-0 (id=34930787)\t79%; AC attached; not charging present: true
`;

test("a battery resting on the charger is neither filling nor draining", () => {
  const battery = parseBattery(CHARGED);
  assert.deepEqual(battery, { percent: 100, charging: false, charged: true, external: true, minutes: null });
});

test("discharging reports the power source and the time left", () => {
  const battery = parseBattery(DISCHARGING);
  assert.deepEqual(battery, { percent: 87, charging: false, charged: false, external: false, minutes: 272 });
});

test("charging reports the time until full", () => {
  const battery = parseBattery(CHARGING);
  assert.deepEqual(battery, { percent: 45, charging: true, charged: false, external: true, minutes: 83 });
});

test("no estimate is null rather than zero", () => {
  assert.equal(parseBattery(NO_ESTIMATE)?.minutes, null);
  assert.equal(parseBattery(NO_ESTIMATE)?.percent, 61);
});

test("AC attached but not charging reads as resting, not as draining", () => {
  const battery = parseBattery(NOT_CHARGING);
  assert.equal(battery?.charging, false);
  assert.equal(battery?.charged, true);
  assert.equal(battery?.external, true);
});

test("a machine without a battery parses as none", () => {
  assert.equal(parseBattery("Now drawing from 'AC Power'\n"), null);
  assert.equal(parseBattery(""), null);
});

test("a probe whose command fails reports no battery rather than throwing", async () => {
  const probe = createBatteryProbe(() => Promise.reject(new Error("pmset: not found")));
  assert.equal(await probe.read(), null);
});

test("a probe passes the command's output through the parser", async () => {
  const probe = createBatteryProbe(() => Promise.resolve(DISCHARGING));
  assert.equal((await probe.read())?.percent, 87);
});
