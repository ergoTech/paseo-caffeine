import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { type Battery, type SetInput, type Status, getStatus, setDisplay, setMode } from "../shared/caffeine.shared.ts";
import { type Strings, detectAppLocale, formatRemaining, t } from "./i18n.ts";

const QUERY_KEY = ["caffeine", "status"] as const;
const TIMER_MINUTES = [30, 60, 120, 180, 480, 720] as const;
type TimerMinutes = (typeof TIMER_MINUTES)[number];

/**
 * The surface fits a phone without scrolling, and what buys the room is the shape rather
 * than the size: Off and On share a row, state and battery share a card, and no section
 * label captions a control that already says what it is. With those, compact only has to
 * be a little tighter than the desktop — shrinking the type as well left half the screen
 * empty. While-agents-work and Timer keep rows of their own: one has a sentence that
 * should not be clipped, the other six chips that want the width.
 */
const METRICS = {
  compact: { gutter: 16, gap: 14, pad: 16, icon: 44, title: 22, tile: "48%" as const },
  roomy: { gutter: 24, gap: 16, pad: 16, icon: 44, title: 24, tile: "48%" as const },
};

/** Which chip a running timer belongs to: the one whose length is nearest. */
function minutesOf(status: Status, now: number): TimerMinutes {
  const left = (Date.parse(status.until) - now) / 60_000;
  return TIMER_MINUTES.reduce((best, m) => (Math.abs(m - left) < Math.abs(best - left) ? m : best));
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

function Card({ theme, pad, children, style }: { theme: PluginTheme; pad: number; children: React.ReactNode; style?: object }) {
  return (
    <View
      style={{
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 16,
        padding: pad,
        gap: 12,
        ...style,
      }}
    >
      {children}
    </View>
  );
}

/** Green with room to spare, amber when it is getting thin, red near empty. */
function batteryColour(battery: Battery, theme: PluginTheme): string {
  if (battery.external) return theme.colors.statusSuccess;
  if (battery.percent <= 10) return theme.colors.statusDanger;
  if (battery.percent <= 25) return theme.colors.statusWarning;
  return theme.colors.statusSuccess;
}

/**
 * The battery as macOS reports it: a filled glyph, the percentage, whether the charger is
 * in, and how long the charge has left — or how long until it is full. The glyph is the
 * progress bar; a second full-width one underneath would say the same thing twice and
 * cost a line the phone does not have.
 */
function BatteryRow({ battery, theme, strings }: { battery: Battery; theme: PluginTheme; strings: Strings }) {
  const colour = batteryColour(battery, theme);
  const eta = battery.minutes === null ? null : formatRemaining(battery.minutes * 60_000, strings);

  let detail: string;
  if (battery.charging) detail = eta ? strings.batteryUntilFull(eta) : strings.batteryNoEstimate;
  else if (battery.charged) detail = strings.batteryCharged;
  else detail = eta ? strings.batteryUntilEmpty(eta) : strings.batteryNoEstimate;

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <View
          style={{
            width: 64,
            height: 30,
            borderRadius: 8,
            borderWidth: 2,
            borderColor: theme.colors.border,
            padding: 3,
            justifyContent: "center",
          }}
        >
          {/* Never a bare sliver: a one percent charge still shows as something. */}
          <View
            style={{
              width: `${Math.max(4, battery.percent)}%`,
              height: "100%",
              borderRadius: 3,
              backgroundColor: colour,
            }}
          />
        </View>
        <View
          style={{
            width: 3,
            height: 10,
            marginLeft: 1,
            borderTopRightRadius: 2,
            borderBottomRightRadius: 2,
            backgroundColor: theme.colors.border,
          }}
        />
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 24, fontWeight: "700" }}>{`${battery.percent}%`}</Text>
        {battery.charging ? <Icon name="Zap" size={15} color={colour} /> : null}
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, flex: 1, textAlign: "right" }}>
          {`${battery.external ? strings.powerAC : strings.powerBattery} · ${detail}`}
        </Text>
      </View>
    </View>
  );
}

/**
 * State and battery in one card: what the Mac is doing, and what it is running on. They
 * were two cards, which cost a border, a set of paddings and a gap for no added meaning.
 */
function StateCard({
  status,
  theme,
  strings,
  now,
  updatedAgo,
  pad,
}: {
  status: Status;
  theme: PluginTheme;
  strings: Strings;
  now: number;
  updatedAgo: number | null;
  pad: number;
}) {
  const awake = status.active;
  const colour = awake ? theme.colors.statusSuccess : theme.colors.foregroundMuted;

  let detail = "";
  let progress: number | null = null;
  if (status.mode === "timer") {
    const remaining = Date.parse(status.until) - now;
    detail = strings.remaining(formatRemaining(remaining, strings));
    progress = Math.min(1, Math.max(0, remaining / (minutesOf(status, now) * 60_000)));
  } else if (status.mode === "auto") {
    detail = status.busy ? strings.agentsRunning(status.agents) : status.tickAt ? strings.agentsIdle : strings.agentsWaiting;
  } else if (status.mode === "on") {
    detail = strings.untilOff;
  }

  return (
    <Card theme={theme} pad={pad}>
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

      {status.battery ? (
        <>
          <View style={{ height: 1, backgroundColor: theme.colors.border }} />
          <BatteryRow battery={status.battery} theme={theme} strings={strings} />
        </>
      ) : null}

      {status.error ? (
        <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{`${strings.errorPrefix}: ${status.error}`}</Text>
      ) : null}

      {updatedAgo !== null ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{strings.updated(updatedAgo)}</Text>
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
  tile,
}: {
  icon: string;
  title: string;
  detail: string;
  selected: boolean;
  theme: PluginTheme;
  onPress?: () => void;
  children?: React.ReactNode;
  /** Two across on a phone, four across on a desktop. */
  tile: `${number}%`;
}) {
  const body = (
    <View
      style={{
        backgroundColor: selected ? theme.colors.surface2 : theme.colors.surface1,
        borderColor: selected ? theme.colors.accent : theme.colors.border,
        borderWidth: selected ? 2 : 1,
        borderRadius: 14,
        padding: 15,
        gap: 6,
        flexBasis: tile,
        flexGrow: 1,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon name={icon} size={16} color={selected ? theme.colors.accent : theme.colors.foregroundMuted} />
        <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600" }}>{title}</Text>
      </View>
      {/* No line limit: a clipped "…after the last agent goe…" reads worse than a third line. */}
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{detail}</Text>
      {children}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress} style={{ flexBasis: tile, flexGrow: 1 }}>
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
  const strings = t(detectAppLocale());
  const now = useNow();
  const fetchStatus = useRpc(getStatus);
  const applyMode = useRpc(setMode);
  const applyDisplay = useRpc(setDisplay);
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

  const changeDisplay = useMutation({
    mutationFn: (keepDisplay: boolean) => applyDisplay({ keepDisplay }),
    onSuccess: (status) => queryClient.setQueryData(QUERY_KEY, status),
  });

  const compact = layout.compact;
  const m = compact ? METRICS.compact : METRICS.roomy;
  const timerMinutes = data?.mode === "timer" ? minutesOf(data, now) : null;
  const updatedAgo = data?.tickAt ? Math.max(0, Math.round((now - Date.parse(data.tickAt)) / 1000)) : null;

  return (
    // Still a ScrollView: the content is meant to fit, but a small enough phone would
    // otherwise cut the switch off with no way to reach it.
    <ScrollView
      style={{ backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: m.gutter, gap: m.gap, maxWidth: 760, width: "100%", alignSelf: "center" }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
        <View
          style={{
            width: m.icon,
            height: m.icon,
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
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: m.title, fontWeight: "700" }}>{strings.title}</Text>
          {/* The phone gets the line that carries the meaning, not the one that repeats the title. */}
          {compact ? null : <Text style={{ color: theme.colors.foreground, fontSize: 14 }}>{strings.tagline}</Text>}
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 14 }}>
            {strings.taglineDetail(data?.keepDisplay ?? false)}
          </Text>
        </View>
      </View>

      {isLoading || !data ? (
        <ActivityIndicator color={theme.colors.accent} />
      ) : (
        <>
          <StateCard status={data} theme={theme} strings={strings} now={now} updatedAgo={updatedAgo} pad={m.pad} />

          {compact ? null : (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600", letterSpacing: 1, textTransform: "uppercase" }}>
              {strings.modeLabel}
            </Text>
          )}

          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: m.gap }}>
            <ModeCard
              icon="Power"
              title={strings.off}
              detail={strings.offDetail}
              selected={data.mode === "off"}
              theme={theme}
              tile={m.tile}
              onPress={() => change.mutate({ mode: "off" })}
            />
            <ModeCard
              icon="Sun"
              title={strings.on}
              detail={strings.onDetail}
              selected={data.mode === "on"}
              theme={theme}
              tile={m.tile}
              onPress={() => change.mutate({ mode: "on" })}
            />
          </View>

          {/* A row each: one has a sentence to finish, the other six chips to lay out. */}
          <ModeCard
            icon="Zap"
            title={strings.auto}
            detail={strings.autoDetail}
            selected={data.mode === "auto"}
            theme={theme}
            tile="100%"
            onPress={() => change.mutate({ mode: "auto" })}
          />

          <ModeCard icon="Timer" title={strings.timer} detail={strings.timerDetail} selected={data.mode === "timer"} theme={theme} tile="100%">
            <View style={{ flexDirection: "row", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
              {TIMER_MINUTES.map((minutes) => (
                <Chip
                  key={minutes}
                  label={formatRemaining(minutes * 60_000, strings)}
                  selected={timerMinutes === minutes}
                  theme={theme}
                  onPress={() => change.mutate({ mode: "timer", minutes })}
                />
              ))}
            </View>
          </ModeCard>

          <Card theme={theme} pad={6}>
            <SettingsSwitch
              label={strings.displayLabel}
              hint={strings.displayHint}
              value={data.keepDisplay}
              onValueChange={(next) => changeDisplay.mutate(next)}
              disabled={changeDisplay.isPending}
            />
          </Card>
        </>
      )}
    </ScrollView>
  );
}
