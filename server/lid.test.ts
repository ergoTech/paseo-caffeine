import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type { Battery } from "../shared/caffeine.shared.ts";
import {
  GUARD_LABEL,
  type LidDeps,
  type LidStored,
  createLid,
  guardPlist,
  parseSleepDisabled,
  setupScript,
  sudoersRule,
  thermalWarning,
} from "./lid.server.ts";

const T0 = Date.parse("2026-10-20T12:00:00Z");
const OFF: LidStored = { until: "", minutes: 0, forever: false };

/** A Mac in miniature: the sudo rule, the SleepDisabled switch, the guard, and every call. */
function fakeMac(
  options: {
    ready?: boolean;
    disabled?: boolean;
    stored?: LidStored;
    failOff?: number;
    failOn?: boolean;
    guardFails?: boolean;
    unreadable?: boolean;
    hot?: () => boolean;
    admin?: () => Promise<void>;
  } = {},
) {
  let ready = options.ready ?? true;
  let disabled = options.disabled ?? false;
  let stored: LidStored = options.stored ?? { ...OFF };
  let failOff = options.failOff ?? 0;
  let guard: number | null = null;
  let clock = T0;
  const calls: string[] = [];
  const deps: LidDeps = {
    run: async (command, args) => {
      const line = [command, ...args].join(" ");
      if (line === "/usr/bin/sudo -n -l /usr/bin/pmset -a disablesleep 1") return { code: ready ? 0 : 1, stdout: "" };
      if (line === "/usr/bin/pmset -g therm") {
        return { code: 0, stdout: options.hot?.() ? "CPU_Speed_Limit \t= 70\n" : "Note: No thermal warning level has been recorded\n" };
      }
      if (line === "/usr/bin/pmset -g") {
        return options.unreadable ? { code: 1, stdout: "" } : { code: 0, stdout: ` sleep 5\n SleepDisabled\t\t${disabled ? 1 : 0}\n` };
      }
      calls.push(line);
      if (!ready) return { code: 1, stdout: "" };
      if (line.endsWith("disablesleep 1")) {
        if (options.failOn) return { code: 1, stdout: "" };
        disabled = true;
      }
      if (line.endsWith("disablesleep 0")) {
        if (failOff > 0) return (failOff -= 1), { code: 1, stdout: "" };
        disabled = false;
      }
      return { code: 0, stdout: "" };
    },
    admin: options.admin ?? (async () => void (calls.push("admin"), (ready = true))),
    startGuard: async (untilMs) => {
      calls.push(`guard ${new Date(untilMs).toISOString()}`);
      if (options.guardFails) return false;
      guard = untilMs;
      return true;
    },
    stopGuard: async () => void (calls.push("stop guard"), (guard = null)),
    read: async () => stored,
    write: async (value) => void (stored = value),
    user: () => "ergo",
    now: () => clock,
  };
  return {
    deps,
    calls,
    stored: () => stored,
    disabled: () => disabled,
    guard: () => guard,
    setDisabled: (value: boolean) => void (disabled = value),
    advance: (ms: number) => void (clock += ms),
  };
}

const onBattery = (percent: number): Battery => ({ percent, charging: false, charged: false, external: false, minutes: null });
const at = (ms: number) => new Date(ms).toISOString();

test("pmset's SleepDisabled line is read, and its absence is not a yes", () => {
  assert.equal(parseSleepDisabled(" sleep 5\n SleepDisabled\t\t1\n"), true);
  assert.equal(parseSleepDisabled(" SleepDisabled 0"), false);
  assert.equal(parseSleepDisabled(" sleep 5\n"), null);
});

test("the sudoers rule allows exactly the two pmset commands, for a plain user name only", () => {
  assert.equal(
    sudoersRule("ergo"),
    "ergo ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 1, /usr/bin/pmset -a disablesleep 0",
  );
  assert.throws(() => sudoersRule("ergo ALL=(ALL) ALL #"));
  assert.throws(() => sudoersRule("o'neil"));
  assert.throws(() => sudoersRule(""));
});

test("the setup script is valid sh and checks the rule with visudo before installing it", () => {
  const script = setupScript(sudoersRule("ergo"));
  execFileSync("/bin/sh", ["-n", "-c", script]);
  assert.ok(script.startsWith("set -e"), "any failure stops it");
  assert.ok(script.indexOf("visudo -cf") < script.indexOf("install -m 0440"), "checked, then installed");
  assert.match(script, /\/etc\/sudoers\.d\/paseo-caffeine/);
});

test("the guard is a LaunchAgent that runs at load, waits for the deadline, restores sleep and removes itself", () => {
  const plist = guardPlist(T0);
  assert.match(plist, new RegExp(`<string>${GUARD_LABEL.replace(/\./g, "\\.")}</string>`));
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  const script = /<string>-c<\/string>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1] ?? "";
  execFileSync("/bin/sh", ["-n", "-c", script]);
  assert.ok(script.includes(`${Math.ceil(T0 / 1000)} - `), "waits for the deadline");
  assert.ok(script.indexOf("disablesleep 0") < script.indexOf("rm -f"), "sleep first, then it removes itself");
  assert.ok(plist.endsWith("</plist>\n"));
});

test("without the permission, turning it on changes nothing and asks for setup", async () => {
  const mac = fakeMac({ ready: false });
  const lid = createLid(mac.deps);
  await lid.start();
  await lid.enable(30);
  assert.deepEqual(mac.calls, []);
  assert.equal(lid.status().setup, "needs-setup");
  assert.equal(mac.disabled(), false);
});

test("setup goes through the admin dialog, after which it can be turned on", async () => {
  const mac = fakeMac({ ready: false });
  const lid = createLid(mac.deps);
  await lid.start();
  await lid.setup();
  assert.equal(lid.status().setup, "ready");
  await lid.enable(60);
  assert.equal(lid.status().on, true);
});

test("cancelling the password dialog is not reported as a failure", async () => {
  const mac = fakeMac({ ready: false, admin: async () => Promise.reject(new Error("execution error: User canceled. (-128)")) });
  const lid = createLid(mac.deps);
  await lid.start();
  await lid.setup();
  assert.equal(lid.status().error, "");
  assert.equal(lid.status().setup, "needs-setup");
});

test("turning it on arms the guard before switching sleep off, and records the deadline and length", async () => {
  const mac = fakeMac();
  const lid = createLid(mac.deps);
  await lid.start();
  await lid.enable(30);
  assert.deepEqual(mac.calls, [`guard ${at(T0 + 31 * 60_000)}`, "/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 1"]);
  assert.deepEqual(mac.stored(), { until: at(T0 + 30 * 60_000), minutes: 30, forever: false });
  assert.equal(lid.status().on, true);
  assert.equal(lid.status().minutes, 30);
});

test("a guard that cannot be armed keeps sleep on", async () => {
  const mac = fakeMac({ guardFails: true });
  const lid = createLid(mac.deps);
  await lid.start();
  await lid.enable(30);
  assert.equal(mac.disabled(), false);
  assert.notEqual(lid.status().error, "");
  assert.deepEqual(mac.stored(), OFF);
});

test("a pmset that fails to switch sleep off disarms the guard again and records nothing", async () => {
  const mac = fakeMac({ failOn: true });
  const lid = createLid(mac.deps);
  await lid.start();
  await lid.enable(30);
  assert.match(lid.status().error, /disablesleep 1 failed/);
  assert.equal(mac.guard(), null);
  assert.deepEqual(mac.stored(), OFF);
});

test("at the deadline sleep comes back, then the guard and the deadline go", async () => {
  const mac = fakeMac();
  const lid = createLid(mac.deps);
  await lid.start();
  await lid.enable(30);
  mac.advance(29 * 60_000);
  await lid.tick(null);
  assert.equal(mac.disabled(), true, "not yet");
  mac.advance(60_000);
  await lid.tick(null);
  assert.equal(mac.disabled(), false);
  assert.equal(mac.guard(), null);
  assert.deepEqual(mac.stored(), OFF);
});

test("if restoring sleep fails, the deadline and the guard stay, and the next tick tries again", async () => {
  const mac = fakeMac({ failOff: 1 });
  const lid = createLid(mac.deps);
  await lid.start();
  await lid.enable(30);
  mac.advance(31 * 60_000);
  await lid.tick(null);
  assert.equal(mac.disabled(), true);
  assert.notEqual(mac.guard(), null, "the guard still stands");
  assert.equal(mac.stored().until, at(T0 + 30 * 60_000), "the deadline still stands");
  await lid.tick(null);
  assert.equal(mac.disabled(), false);
  assert.deepEqual(mac.stored(), OFF);
});

test("a low battery ends it early, the charger does not", async () => {
  const charging = fakeMac();
  const plugged = createLid(charging.deps);
  await plugged.start();
  await plugged.enable(120);
  await plugged.tick({ ...onBattery(5), external: true });
  assert.equal(charging.disabled(), true, "on the charger it holds");

  const mac = fakeMac();
  const lid = createLid(mac.deps);
  await lid.start();
  await lid.enable(120);
  await lid.tick(onBattery(25));
  assert.equal(mac.disabled(), true);
  await lid.tick(onBattery(19));
  assert.equal(mac.disabled(), false);
});

test("a deadline that passed while Paseo was down is put right on start", async () => {
  const mac = fakeMac({ disabled: true, stored: { until: at(T0 - 1), minutes: 30, forever: false } });
  const lid = createLid(mac.deps);
  await lid.start();
  assert.equal(mac.disabled(), false);
  assert.ok(mac.calls.includes("stop guard"));
  assert.deepEqual(mac.stored(), OFF);
});

test("a deadline still ahead on start re-arms the guard, as after a reboot", async () => {
  const mac = fakeMac({ disabled: true, stored: { until: at(T0 + 10 * 60_000), minutes: 30, forever: false } });
  const lid = createLid(mac.deps);
  await lid.start();
  assert.deepEqual(mac.calls, [`guard ${at(T0 + 11 * 60_000)}`]);
  assert.equal(mac.disabled(), true, "the session carries on");
});

test("a deadline that does not parse counts as due", async () => {
  const mac = fakeMac({ disabled: true, stored: { until: "garbage", minutes: 30, forever: false } });
  const lid = createLid(mac.deps);
  await lid.start();
  assert.equal(mac.disabled(), false);
});

test("sleep switched back on by hand ends the timing; an unreadable state does not", async () => {
  const mac = fakeMac();
  const lid = createLid(mac.deps);
  await lid.start();
  await lid.enable(60);
  mac.setDisabled(false);
  await lid.tick(null);
  assert.deepEqual(mac.stored(), OFF);
  assert.equal(mac.guard(), null);

  const blind = fakeMac({ disabled: true, unreadable: true, stored: { until: at(T0 + 10 * 60_000), minutes: 30, forever: false } });
  const unknown = createLid(blind.deps);
  await unknown.start();
  await unknown.tick(null);
  assert.equal(blind.stored().until, at(T0 + 10 * 60_000), "unknown is not off");
});

test("a turn-off overtaken by a turn-on runs in order: the new deadline survives", async () => {
  const mac = fakeMac();
  const lid = createLid(mac.deps);
  await lid.start();
  await lid.enable(30);
  await Promise.all([lid.disable("turned off"), lid.enable(120)]);
  assert.equal(mac.disabled(), true);
  assert.deepEqual(mac.stored(), { until: at(T0 + 120 * 60_000), minutes: 120, forever: false });
  assert.equal(mac.guard(), T0 + 121 * 60_000);
});

test("turning it on again replaces the guard with one for the new deadline", async () => {
  const mac = fakeMac();
  const lid = createLid(mac.deps);
  await lid.start();
  await lid.enable(30);
  await lid.enable(120);
  assert.equal(mac.guard(), T0 + 121 * 60_000);
  assert.equal(mac.stored().minutes, 120);
});

test("setup waiting on the password dialog does not hold up the ticks", async () => {
  const mac = fakeMac({ ready: false, admin: () => new Promise<void>(() => undefined) });
  const lid = createLid(mac.deps);
  await lid.start();
  void lid.setup();
  const ticked = await Promise.race([lid.tick(null).then(() => "ticked"), new Promise((resolve) => setTimeout(() => resolve("stuck"), 200))]);
  assert.equal(ticked, "ticked");
});

test("a failed restore on a Mac already put right by hand still lets go", async () => {
  const mac = fakeMac({ failOff: 99 });
  const lid = createLid(mac.deps);
  await lid.start();
  await lid.enable(30);
  mac.advance(31 * 60_000);
  mac.setDisabled(false);
  await lid.tick(null);
  assert.deepEqual(mac.stored(), OFF);
  assert.equal(mac.guard(), null);
});

test("the guard keeps trying and leaves only once sleep is confirmed back", () => {
  const script = /<string>-c<\/string>\s*<string>([^<]*)<\/string>/.exec(guardPlist(T0))?.[1] ?? "";
  assert.match(script, /while \[ "\$i" -lt 30 \]/);
  assert.ok(script.indexOf("SleepDisabled") < script.indexOf("rm -f"), "checks before removing itself");
});

test("hot is a recorded warning level or a CPU held below full speed; the all-clear notes are not", () => {
  const clear = "Note: No thermal warning level has been recorded\nNote: No performance warning level has been recorded\nNote: No CPU power status has been recorded\n";
  assert.equal(thermalWarning(clear), false);
  assert.equal(thermalWarning("Thermal warning level set to 1.\n"), true);
  assert.equal(thermalWarning("Thermal warning level set to 0.\n"), false, "the all-clear after a warm spell");
  assert.equal(thermalWarning("Performance warning level recorded\n"), true, "a level that cannot be read counts as hot");
  assert.equal(thermalWarning("CPU_Scheduler_Limit \t= 100\nCPU_Available_CPUs \t= 8\nCPU_Speed_Limit \t= 70\n"), true);
  assert.equal(thermalWarning("CPU_Speed_Limit \t= 100\n"), false);
  assert.equal(thermalWarning(""), false);
});

test("always: sleep is switched off with no deadline and no guard, and time never ends it", async () => {
  const mac = fakeMac();
  const lid = createLid(mac.deps);
  await lid.start();
  await lid.enable("forever");
  assert.deepEqual(mac.calls, ["/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 1", "stop guard"], "sleep off first, then the old guard goes");
  assert.deepEqual(mac.stored(), { until: "", minutes: 0, forever: true });
  assert.equal(mac.guard(), null);
  mac.advance(30 * 24 * 60 * 60_000);
  await lid.tick(onBattery(80));
  assert.equal(mac.disabled(), true, "a month later it still holds");
  assert.equal(lid.status().forever, true);
});

test("always ends on a low battery, and on heat", async () => {
  const battery = fakeMac();
  const low = createLid(battery.deps);
  await low.start();
  await low.enable("forever");
  await low.tick(onBattery(15));
  assert.equal(battery.disabled(), false);
  assert.deepEqual(battery.stored(), OFF);

  let hot = false;
  const warm = fakeMac({ hot: () => hot });
  const lid = createLid(warm.deps);
  await lid.start();
  await lid.enable("forever");
  await lid.tick(null);
  assert.equal(warm.disabled(), true, "cool: holds");
  hot = true;
  await lid.tick(null);
  assert.equal(warm.disabled(), false);
});

test("heat ends a timed lid mode too", async () => {
  const mac = fakeMac({ hot: () => true });
  const lid = createLid(mac.deps);
  await lid.start();
  await lid.enable(120);
  await lid.tick(null);
  assert.equal(mac.disabled(), false);
});

test("always survives a restart; one switched off by hand meanwhile is let go", async () => {
  const kept = fakeMac({ disabled: true, stored: { until: "", minutes: 0, forever: true } });
  const lid = createLid(kept.deps);
  await lid.start();
  assert.equal(kept.disabled(), true);
  assert.deepEqual(kept.calls, [], "no guard, nothing restored");
  assert.equal(lid.status().forever, true);

  const offByHand = fakeMac({ disabled: false, stored: { until: "", minutes: 0, forever: true } });
  await createLid(offByHand.deps).start();
  assert.deepEqual(offByHand.stored(), OFF);
});

test("turning always off restores sleep; switching from always to a timer arms a guard", async () => {
  const mac = fakeMac();
  const lid = createLid(mac.deps);
  await lid.start();
  await lid.enable("forever");
  await lid.enable(30);
  assert.notEqual(mac.guard(), null);
  assert.equal(mac.stored().forever, false);
  await lid.enable("forever");
  assert.equal(mac.guard(), null, "the timer's guard goes");
  await lid.disable("turned off");
  assert.equal(mac.disabled(), false);
  assert.deepEqual(mac.stored(), OFF);
});

test("the tile is told why lid mode ended by itself, until it is turned on again", async () => {
  const mac = fakeMac({ hot: () => true });
  const lid = createLid(mac.deps);
  await lid.start();
  await lid.enable("forever");
  await lid.tick(null);
  assert.equal(lid.status().ended, "heat");
  const cool = fakeMac();
  const again = createLid(cool.deps);
  await again.start();
  await again.enable("forever");
  await again.tick(onBattery(10));
  assert.equal(again.status().ended, "battery");
  await again.enable(30);
  assert.equal(again.status().ended, "");
});

test("a failed switch from a timer to always keeps the timer's guard", async () => {
  let fail = false;
  const mac = fakeMac();
  const run = mac.deps.run;
  mac.deps.run = async (command, args) =>
    fail && args.join(" ").endsWith("disablesleep 1") ? { code: 1, stdout: "" } : run(command, args);
  const lid = createLid(mac.deps);
  await lid.start();
  await lid.enable(30);
  fail = true;
  await lid.enable("forever");
  assert.notEqual(mac.guard(), null);
  assert.equal(mac.stored().forever, false);
});
