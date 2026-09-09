import type { PluginSurfaceProps, PluginTheme } from "@getpaseo/plugin";
import { Icon, useRpc } from "@getpaseo/plugin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { type SetInput, type Status, getStatus, setMode } from "./caffeine.shared.ts";
import { type Strings, detectLocale, formatRemaining, t } from "./i18n.ts";

const QUERY_KEY = ["caffeine", "status"] as const;
const TIMER_HOURS = [1, 3, 8] as const;
type TimerHours = (typeof TIMER_HOURS)[number];

/** Which button a running timer belongs to: the one whose length is nearest. */
function hoursOf(status: Status, now: number): TimerHours {
  const remainingHours = (Date.parse(status.until) - now) / 3_600_000;
  return TIMER_HOURS.reduce((best, h) => (Math.abs(h - remainingHours) < Math.abs(best - remainingHours) ? h : best));
}

/** A clock that ticks once a second, so the remaining time moves between refetches. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function Card({ theme, children, style }: { theme: PluginTheme; children: React.ReactNode; style?: object }) {
  return (
    <View
      style={{
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 16,
        padding: 16,
        gap: 10,
        ...style,
      }}
    >
      {children}
    </View>
  );
}

function StatusCard({ status, theme, strings, now }: { status: Status; theme: PluginTheme; strings: Strings; now: number }) {
  const awake = status.active;
  const colour = awake ? theme.colors.statusSuccess : theme.colors.foregroundMuted;

  let detail = "";
  let progress: number | null = null;
  if (status.mode === "timer") {
    const remaining = Date.parse(status.until) - now;
    detail = strings.remaining(formatRemaining(remaining, strings));
    progress = Math.min(1, Math.max(0, remaining / (hoursOf(status, now) * 3_600_000)));
  } else if (status.mode === "auto") {
    detail = status.busy ? strings.agentsRunning(status.agents) : status.tickAt ? strings.agentsIdle : strings.agentsWaiting;
  } else if (status.mode === "on") {
    detail = strings.untilOff;
  }

  return (
    <Card theme={theme}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexShrink: 1 }}>
          <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: colour }} />
          <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "700", letterSpacing: 1 }}>
            {awake ? strings.stateAwake : strings.stateAsleep}
          </Text>
        </View>
        {detail ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, flexShrink: 1, textAlign: "right" }}>
            {detail}
          </Text>
        ) : null}
      </View>

      {progress !== null ? (
        <View style={{ height: 4, borderRadius: 2, backgroundColor: theme.colors.border, overflow: "hidden" }}>
          <View style={{ width: `${Math.round(progress * 100)}%`, height: 4, backgroundColor: theme.colors.accent }} />
        </View>
      ) : null}

      {status.error ? (
        <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{`${strings.errorPrefix}: ${status.error}`}</Text>
      ) : null}
    </Card>
  );
}

function ModeCard({
  icon,
  title,
  detail,
  selected,
  theme,
  onPress,
  children,
  compact,
}: {
  icon: string;
  title: string;
  detail: string;
  selected: boolean;
  theme: PluginTheme;
  onPress?: () => void;
  children?: React.ReactNode;
  compact: boolean;
}) {
  const body = (
    <View
      style={{
        backgroundColor: selected ? theme.colors.surface2 : theme.colors.surface1,
        borderColor: selected ? theme.colors.accent : theme.colors.border,
        borderWidth: selected ? 2 : 1,
        borderRadius: 14,
        padding: 14,
        gap: 6,
        // Three across on a desktop, one under another on a phone.
        flexBasis: compact ? "100%" : "30%",
        flexGrow: 1,
        minWidth: compact ? undefined : 150,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon name={icon} size={16} color={selected ? theme.colors.accent : theme.colors.foregroundMuted} />
        <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600" }}>{title}</Text>
      </View>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{detail}</Text>
      {children}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress} style={{ flexBasis: compact ? "100%" : "30%", flexGrow: 1 }}>
      {body}
    </Pressable>
  );
}

function Chip({ label, selected, theme, onPress }: { label: string; selected: boolean; theme: PluginTheme; onPress(): void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={{
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: selected ? theme.colors.accent : theme.colors.border,
        backgroundColor: selected ? theme.colors.accent : "transparent",
      }}
    >
      <Text style={{ color: selected ? theme.colors.accentForeground : theme.colors.foreground, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

export function CaffeineSurface({ theme, layout }: PluginSurfaceProps) {
  const strings = t(detectLocale());
  const now = useNow();
  const fetchStatus = useRpc(getStatus);
  const applyMode = useRpc(setMode);
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => fetchStatus({}),
    // Five seconds: the agent count and the tick time are read by a person glancing
    // at a screen; the remaining time itself ticks locally every second.
    refetchInterval: 5_000,
  });

  const change = useMutation({
    mutationFn: (input: SetInput) => applyMode(input),
    onSuccess: (status) => queryClient.setQueryData(QUERY_KEY, status),
  });

  const compact = layout.compact;
  const gutter = compact ? 16 : 24;
  const timerHours = data?.mode === "timer" ? hoursOf(data, now) : null;
  const updatedAgo = data?.tickAt ? Math.max(0, Math.round((now - Date.parse(data.tickAt)) / 1000)) : null;

  return (
    <ScrollView style={{ backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: gutter, gap: 16, maxWidth: 760, width: "100%", alignSelf: "center" }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 14 }}>
        <View
          style={{
            width: 44,
            height: 44,
            borderRadius: 12,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: theme.colors.surface2,
            borderWidth: 1,
            borderColor: theme.colors.border,
          }}
        >
          <Icon name="Coffee" size={22} color={theme.colors.accent} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: compact ? 20 : 24, fontWeight: "700" }}>{strings.title}</Text>
          <Text style={{ color: theme.colors.foreground, fontSize: 14 }}>{strings.tagline}</Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{strings.taglineDetail}</Text>
        </View>
      </View>

      {isLoading || !data ? (
        <ActivityIndicator color={theme.colors.accent} />
      ) : (
        <>
          <StatusCard status={data} theme={theme} strings={strings} now={now} />

          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600", letterSpacing: 1, textTransform: "uppercase" }}>
            {strings.modeLabel}
          </Text>

          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
            <ModeCard
              icon="Power"
              title={strings.off}
              detail={strings.offDetail}
              selected={data.mode === "off"}
              theme={theme}
              compact={compact}
              onPress={() => change.mutate({ mode: "off" })}
            />
            <ModeCard
              icon="Sun"
              title={strings.on}
              detail={strings.onDetail}
              selected={data.mode === "on"}
              theme={theme}
              compact={compact}
              onPress={() => change.mutate({ mode: "on" })}
            />
            <ModeCard icon="Timer" title={strings.timer} detail={strings.timerDetail} selected={data.mode === "timer"} theme={theme} compact={compact}>
              <View style={{ flexDirection: "row", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                {TIMER_HOURS.map((h) => (
                  <Chip
                    key={h}
                    label={strings.hours(h)}
                    selected={timerHours === h}
                    theme={theme}
                    onPress={() => change.mutate({ mode: "timer", hours: h })}
                  />
                ))}
              </View>
            </ModeCard>
          </View>

          <Pressable accessibilityRole="button" accessibilityState={{ selected: data.mode === "auto" }} onPress={() => change.mutate({ mode: "auto" })}>
            <View
              style={{
                backgroundColor: data.mode === "auto" ? theme.colors.surface2 : theme.colors.surface1,
                borderColor: data.mode === "auto" ? theme.colors.accent : theme.colors.border,
                borderWidth: data.mode === "auto" ? 2 : 1,
                borderRadius: 14,
                padding: 14,
                gap: 6,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Icon name="Zap" size={16} color={data.mode === "auto" ? theme.colors.accent : theme.colors.foregroundMuted} />
                <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600" }}>{strings.auto}</Text>
              </View>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{strings.autoDetail}</Text>
            </View>
          </Pressable>

          <Card theme={theme} style={{ gap: 6 }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>{strings.howTitle}</Text>
            {[strings.how1, strings.how2, strings.how3].map((line) => (
              <View key={line} style={{ flexDirection: "row", gap: 8 }}>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>·</Text>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, flex: 1 }}>{line}</Text>
              </View>
            ))}
            {updatedAgo !== null ? (
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, textAlign: "right", marginTop: 4 }}>
                {strings.updated(updatedAgo)}
              </Text>
            ) : null}
          </Card>
        </>
      )}
    </ScrollView>
  );
}
