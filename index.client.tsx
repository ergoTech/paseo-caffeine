import type { PluginCleanup } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { getStatus, setMode, setOptions } from "./shared/caffeine.shared.ts";
import { detectLocale, t } from "./client/i18n.ts";
import { CaffeineSurface } from "./client/main.client.tsx";
import { onHiddenChange, reportHidden } from "./client/sidebar.ts";

export default function contribute(client: PluginClientContext) {
  const strings = t(detectLocale());
  client.addSurface("main", CaffeineSurface);

  // The whole page, a second time, under Settings. This is what makes hiding the sidebar
  // entry safe: the switch that put it away is still reachable from the page itself.
  client.addSettingsScreen({ id: "settings", title: strings.title, icon: "Coffee", Component: CaffeineSurface });

  // The sidebar entry comes and goes with the switch. contribute() runs once and cannot
  // wait for the daemon, so the entry is registered first and withdrawn a moment later if
  // the stored answer says to.
  const sidebarItem = { id: "main", title: strings.sidebarTitle, icon: "Coffee", surface: "main" };
  let removeSidebarItem: PluginCleanup | null = client.addSidebarItem(sidebarItem);
  const stopWatching = onHiddenChange((hidden) => {
    if (hidden) {
      void removeSidebarItem?.();
      removeSidebarItem = null;
    } else if (!removeSidebarItem) {
      removeSidebarItem = client.addSidebarItem(sidebarItem);
    }
  });

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
        await rpc(setOptions, { keepDisplay: command.keepDisplay });
      },
    });
  }

  // Any connecting client calls caffeine.get once, which hands the daemon's API to the
  // probe. Without this, auto mode after a daemon restart would count nothing until
  // somebody opened the surface. The same answer settles the sidebar entry.
  void client
    .rpc(getStatus, {})
    .then((status) => reportHidden(status.hidden))
    .catch(() => undefined);

  return () => {
    stopWatching();
  };
}
