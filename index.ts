import type { PluginContext } from "@getpaseo/plugin";
import { getStatus, setMode } from "./caffeine.shared.ts";
import { detectLocale, t } from "./i18n.ts";
import { CaffeineSurface } from "./main.client.tsx";
import { createAgentsProbe } from "./agents.server.ts";
import { type Controller, createController } from "./controller.server.ts";
import { createKeeper } from "./keeper.server.ts";
import { readStored, writeStored } from "./state.server.ts";

/** True on the daemon, false in the app: React Native has no `process.versions.node`. */
function isServer(): boolean {
  return typeof process !== "undefined" && typeof process.versions?.node === "string";
}

export default function contribute(plugin: PluginContext) {
  // Everything server-side is created lazily and only ever touched inside the guard or
  // a handler: this entry point runs in the client bundle too, where *.server.ts is
  // not present.
  const probe = isServer() ? createAgentsProbe() : null;
  let controller: Controller | null = null;

  function server(): Controller {
    if (!controller) {
      controller = createController({
        read: () => readStored(),
        write: (stored) => writeStored(stored),
        keeper: createKeeper(),
        runningCount: () => probe!.runningCount(),
        log: (line) => console.log(line),
      });
    }
    return controller;
  }

  let started: Promise<void> | null = null;
  function startedServer(): Promise<Controller> {
    const instance = server();
    started ??= instance.start();
    return started.then(() => instance);
  }

  if (probe) {
    // Restore the stored mode as soon as the daemon loads the plugin, so a Mac left
    // "on" overnight stays on through a daemon restart without anybody opening the app.
    void startedServer().catch((error) => console.error(`caffeine: start failed: ${String(error)}`));
  }

  plugin.handle(getStatus, async (_input, { paseo }) => {
    probe!.remember(paseo);
    const instance = await startedServer();
    return instance.status();
  });

  plugin.handle(setMode, async (input, { paseo }) => {
    probe!.remember(paseo);
    const instance = await startedServer();
    return instance.set(input);
  });

  const strings = t(detectLocale());
  plugin.addSurface("main", CaffeineSurface);
  plugin.addSidebarItem({ id: "main", title: strings.sidebarTitle, icon: "Coffee", surface: "main" });

  const commands = [
    { id: "off", title: "Caffeine: off", input: { mode: "off" } as const },
    { id: "on", title: "Caffeine: on", input: { mode: "on" } as const },
    { id: "timer-3h", title: "Caffeine: 3 hours", input: { mode: "timer", hours: 3 } as const },
    { id: "auto", title: "Caffeine: while agents work", input: { mode: "auto" } as const },
  ];
  for (const command of commands) {
    plugin.addCommandCenterItem({
      id: command.id,
      title: command.title,
      icon: "Coffee",
      context: "global",
      keywords: ["caffeine", "sleep", "awake"],
      async onSelect({ rpc }) {
        await rpc(setMode, command.input);
      },
    });
  }

  // Any connecting client calls caffeine.get once, which hands the daemon's API to the
  // probe. Without this, auto mode after a daemon restart would count nothing until
  // somebody opened the surface.
  plugin.addClientSide((client) => {
    void client.rpc(getStatus, {}).catch(() => undefined);
    return () => {};
  });

  return () => {
    controller?.stop();
  };
}
