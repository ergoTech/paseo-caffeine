import { hostname } from "node:os";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { getStatus, setMode, setOptions, sleepNow } from "./shared/caffeine.shared.ts";
import { createAgentsProbe } from "./server/agents.server.ts";
import { createBatteryProbe } from "./server/battery.server.ts";
import { type Controller, createController } from "./server/controller.server.ts";
import { createKeeper } from "./server/keeper.server.ts";
import { renderWakePage } from "./server/page.server.ts";
import { createSleeper } from "./server/sleeper.server.ts";
import { readStored, writeStored } from "./server/state.server.ts";
import { createWaker } from "./server/waker.server.ts";

export default function contribute(server: PluginServerContext) {
  // This file only ever loads on the daemon, so the probe and the controller are built
  // unconditionally, right here — no isServer() guard, no lazy construction to dodge a
  // client bundle that no longer exists for this module.
  const probe = createAgentsProbe();
  const power = createBatteryProbe();
  // The page is rendered per request rather than held: whoever reads it has just woken
  // the Mac, and wants to know what it looks like now — not what it looked like when the
  // plugin loaded. `controller` is referenced before its declaration on purpose; by the
  // time a browser asks, it has long existed.
  const waker = createWaker({
    render: () => {
      const status = controller.status();
      return renderWakePage({
        host: hostname(),
        at: new Date(),
        mode: status.mode,
        active: status.active,
        battery: status.battery,
      });
    },
  });
  const sleeper = createSleeper();
  const controller: Controller = createController({
    read: () => readStored(),
    write: (stored) => writeStored(stored),
    keeper: createKeeper(),
    runningCount: () => probe.runningCount(),
    readBattery: () => power.read(),
    wakeUrl: () => waker.url(),
    sleepNow: () => sleeper.request(),
    log: (line) => console.log(line),
  });

  let started: Promise<void> | null = null;
  function startedServer(): Promise<Controller> {
    // The anchor comes up with the controller rather than on first use: it has to be
    // listening and announced *before* the Mac sleeps, and nobody opens a plugin surface
    // on the way to closing the lid.
    started ??= waker.start().then(() => controller.start());
    return started.then(() => controller);
  }

  // Restore the stored mode as soon as the daemon loads the plugin, so a Mac left
  // "on" overnight stays on through a daemon restart without anybody opening the app.
  void startedServer().catch((error) => console.error(`caffeine: start failed: ${String(error)}`));

  server.handle(getStatus, async (_input, { paseo }) => {
    probe.remember(paseo);
    const instance = await startedServer();
    return instance.status();
  });

  server.handle(setMode, async (input, { paseo }) => {
    probe.remember(paseo);
    const instance = await startedServer();
    return instance.set(input);
  });

  server.handle(setOptions, async (input, { paseo }) => {
    probe.remember(paseo);
    const instance = await startedServer();
    return instance.setOptions(input);
  });

  server.handle(sleepNow, async (_input, { paseo }) => {
    probe.remember(paseo);
    const instance = await startedServer();
    return instance.sleep();
  });

  return () => {
    controller.stop();
    waker.stop();
  };
}
