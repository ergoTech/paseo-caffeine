import type { PluginServerContext } from "@getpaseo/plugin/server";
import { getStatus, setMode } from "./shared/caffeine.shared.ts";
import { createAgentsProbe } from "./server/agents.server.ts";
import { type Controller, createController } from "./server/controller.server.ts";
import { createKeeper } from "./server/keeper.server.ts";
import { readStored, writeStored } from "./server/state.server.ts";

export default function contribute(server: PluginServerContext) {
  // This file only ever loads on the daemon, so the probe and the controller are built
  // unconditionally, right here — no isServer() guard, no lazy construction to dodge a
  // client bundle that no longer exists for this module.
  const probe = createAgentsProbe();
  const controller: Controller = createController({
    read: () => readStored(),
    write: (stored) => writeStored(stored),
    keeper: createKeeper(),
    runningCount: () => probe.runningCount(),
    log: (line) => console.log(line),
  });

  let started: Promise<void> | null = null;
  function startedServer(): Promise<Controller> {
    started ??= controller.start();
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

  return () => {
    controller.stop();
  };
}
