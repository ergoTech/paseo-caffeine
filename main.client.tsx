import type { PluginSurfaceProps, PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { type SetInput, type Status, getStatus, setMode } from "./caffeine.shared.ts";
import { type Strings, detectLocale, formatRemaining, t } from "./i18n.ts";

const QUERY_KEY = ["caffeine", "status"] as const;

function describe(status: Status, strings: Strings, now: number): string {
  switch (status.mode) {
    case "off":
      return strings.sleeps;
    case "on":
      return strings.awakeOn;
    case "timer":
      return strings.awakeTimer(formatRemaining(Date.parse(status.until) - now, strings));
    case "auto":
      if (status.active) return strings.awakeAuto(status.agents);
      return status.tickAt ? strings.autoIdle : strings.autoWaiting;
  }
}

function Choice({
  label,
  selected,
  theme,
  onPress,
}: {
  label: string;
  selected: boolean;
  theme: PluginTheme;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={{
        paddingVertical: 10,
        paddingHorizontal: 14,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: selected ? theme.colors.accent : theme.colors.border,
        backgroundColor: selected ? theme.colors.accent : theme.colors.surface1,
      }}
    >
      <Text style={{ color: selected ? theme.colors.accentForeground : theme.colors.foreground }}>{label}</Text>
    </Pressable>
  );
}

/** Which button a running timer belongs to: the one whose length is nearest. */
function hoursOf(status: Status): number {
  const remainingHours = (Date.parse(status.until) - Date.now()) / 3_600_000;
  return [1, 3, 8].reduce((best, h) => (Math.abs(h - remainingHours) < Math.abs(best - remainingHours) ? h : best), 1);
}

export function CaffeineSurface({ theme, layout }: PluginSurfaceProps) {
  const strings = t(detectLocale());
  const fetchStatus = useRpc(getStatus);
  const applyMode = useRpc(setMode);
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => fetchStatus({}),
    // Five seconds: a timer's remaining time and the agent count are read by a
    // person glancing at a screen, not by a machine.
    refetchInterval: 5_000,
  });

  const change = useMutation({
    mutationFn: (input: SetInput) => applyMode(input),
    onSuccess: (status) => queryClient.setQueryData(QUERY_KEY, status),
  });

  const choices: Array<{ label: string; input: SetInput; selected(status: Status): boolean }> = [
    { label: strings.off, input: { mode: "off" }, selected: (s) => s.mode === "off" },
    { label: strings.on, input: { mode: "on" }, selected: (s) => s.mode === "on" },
    { label: strings.h1, input: { mode: "timer", hours: 1 }, selected: (s) => s.mode === "timer" && hoursOf(s) === 1 },
    { label: strings.h3, input: { mode: "timer", hours: 3 }, selected: (s) => s.mode === "timer" && hoursOf(s) === 3 },
    { label: strings.h8, input: { mode: "timer", hours: 8 }, selected: (s) => s.mode === "timer" && hoursOf(s) === 8 },
    { label: strings.auto, input: { mode: "auto" }, selected: (s) => s.mode === "auto" },
  ];

  const gutter = layout.compact ? 16 : 24;

  return (
    <ScrollView
      style={{ backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ flexGrow: 1, padding: gutter, gap: 16 }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: layout.compact ? 20 : 24, fontWeight: "600" }}>
        {strings.title}
      </Text>

      {isLoading || !data ? (
        <ActivityIndicator color={theme.colors.accent} />
      ) : (
        <>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <View
              style={{
                width: 10,
                height: 10,
                borderRadius: 5,
                backgroundColor: data.active ? theme.colors.statusSuccess : theme.colors.foregroundMuted,
              }}
            />
            <Text style={{ color: theme.colors.foreground, flexShrink: 1 }}>{describe(data, strings, Date.now())}</Text>
          </View>

          {data.error ? (
            <Text style={{ color: theme.colors.statusDanger }}>{`${strings.errorPrefix}: ${data.error}`}</Text>
          ) : null}

          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {choices.map((choice) => (
              <Choice
                key={choice.label}
                label={choice.label}
                selected={choice.selected(data)}
                theme={theme}
                onPress={() => change.mutate(choice.input)}
              />
            ))}
          </View>
        </>
      )}
    </ScrollView>
  );
}
