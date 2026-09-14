import type { PluginClientContext } from "@getpaseo/plugin/client";
import { getStatus, setDisplay, setMode } from "./shared/caffeine.shared.ts";
import { detectLocale, t } from "./client/i18n.ts";
import { CaffeineSurface } from "./client/main.client.tsx";

export default function contribute(client: PluginClientContext) {
  const strings = t(detectLocale());
  client.addSurface("main", CaffeineSurface);
  client.addSidebarItem({ id: "main", title: strings.sidebarTitle, icon: "Coffee", surface: "main" });

  const commands = [
    { id: "off", title: "Caffeine: off", input: { mode: "off" } as const },
    { id: "on", title: "Caffeine: on", input: { mode: "on" } as const },
    { id: "timer-3h", title: "Caffeine: 3 hours", input: { mode: "timer", minutes: 180 } as const },
    { id: "auto", title: "Caffeine: while agents work", input: { mode: "auto" } as const },
  ];
  for (const command of commands) {
    client.addCommandCenterItem({
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

  // Ids start with a letter: the app refuses one that does not, and a single bad item
  // takes the whole client contribution down with it, sidebar entry included.
  const displayCommands = [
    { id: "display-on", title: "Caffeine: keep the display on", keepDisplay: true },
    { id: "display-off", title: "Caffeine: let the display sleep", keepDisplay: false },
  ];
  for (const command of displayCommands) {
    client.addCommandCenterItem({
      id: command.id,
      title: command.title,
      icon: "Coffee",
      context: "global",
      keywords: ["caffeine", "display", "screen", "sleep"],
      async onSelect({ rpc }) {
        await rpc(setDisplay, { keepDisplay: command.keepDisplay });
      },
    });
  }

  // Any connecting client calls caffeine.get once, which hands the daemon's API to the
  // probe. Without this, auto mode after a daemon restart would count nothing until
  // somebody opened the surface.
  void client.rpc(getStatus, {}).catch(() => undefined);

  return () => {};
}
