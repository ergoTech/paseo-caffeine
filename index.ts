import type { PluginContext, PluginSurfaceProps } from "@getpaseo/plugin";
import { defineRpc } from "@getpaseo/plugin/server";
import { useRpc } from "@getpaseo/plugin";
import { useQuery } from "@tanstack/react-query";
import React from "react";
import { Text, View } from "react-native";
import { z } from "zod";
import { rememberPaseo, startProbe } from "./probe.server.ts";

const ping = defineRpc({ name: "caffeine.ping", input: z.object({}), output: z.object({ ok: z.boolean() }) });

/** True on the daemon, false in the app: React Native has no `process.versions.node`. */
function isServer(): boolean {
  return typeof process !== "undefined" && typeof process.versions?.node === "string";
}

function Probe({ theme }: PluginSurfaceProps) {
  const call = useRpc(ping);
  const { data } = useQuery({ queryKey: ["caffeine", "ping"], queryFn: () => call({}) });
  // createElement rather than JSX: this file is index.ts, and the real surface arrives
  // in Task 7 as a .tsx file of its own.
  return React.createElement(
    View,
    { style: { flex: 1, padding: 16, backgroundColor: theme.colors.surface0 } },
    React.createElement(Text, { style: { color: theme.colors.foreground } }, data?.ok ? "pinged" : "pinging…"),
  );
}

export default function contribute(plugin: PluginContext) {
  let stopProbe: (() => void) | null = null;
  if (isServer()) {
    stopProbe = startProbe();
  }
  plugin.handle(ping, async (_input, { paseo }) => {
    rememberPaseo(paseo);
    return { ok: true };
  });
  plugin.addSurface("main", Probe);
  plugin.addSidebarItem({ id: "main", title: "Caffeine", icon: "Coffee", surface: "main" });
  return () => {
    stopProbe?.();
  };
}
