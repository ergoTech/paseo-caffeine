import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Animated, Linking, Pressable, ScrollView, Text, View } from "react-native";
import { SLEEP_DELAY_MS, type Battery, type LidMinutes, type SetInput, type SetOptionsInput, type Status, getStatus, setLid, setLidDisplay, setMode, setOptions, setupLid, sleepNow } from "../shared/caffeine.shared.ts";
import { type Strings, detectAppLocale, formatRemaining, t } from "./i18n.ts";
import { SILENCE_TIMEOUT_MS, type SleepEvent, type SleepPhase, isSleepInFlight, nextSleepPhase } from "./sleep-phase.ts";

const QUERY_KEY = ["caffeine", "status"] as const;
const TIMER_MINUTES = [30, 60, 120, 180, 480, 720] as const;
type TimerMinutes = (typeof TIMER_MINUTES)[number];
const LID_MINUTES: readonly LidMinutes[] = [30, 60, 120];

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
  iconPulse,
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
  /** Breathes the glyph while something is in flight; steady when absent. */
  iconPulse?: Animated.Value;
}) {
  const glyph = <Icon name={icon} size={16} color={selected ? theme.colors.accent : theme.colors.foregroundMuted} />;
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
        {iconPulse ? <Animated.View style={{ opacity: iconPulse }}>{glyph}</Animated.View> : glyph}
        {/* flex so a title too long for the tile wraps inside it instead of over the border. */}
        <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600", flex: 1 }}>{title}</Text>
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

/** Which sentence the tile is telling right now. */
function sleepDetailFor(phase: SleepPhase, strings: Strings): string {
  switch (phase) {
    case "asking":
      return strings.sleepAsking;
    case "going":
      return strings.sleepGoing;
    case "asleep":
      return strings.sleepAsleep;
    case "idle":
      return strings.sleepDetail;
  }
}

/**
 * The Sleep tile's little life: which phase it is in, and the two values that show it.
 *
 * The phases come from the status poll rather than from the mutation, because the
 * mutation cannot report the thing that matters. `pmset sleepnow` suspends the Mac a
 * second after the reply goes out, and a suspended Mac does not send a second message
 * saying so — it simply stops answering. So an answer means "still here", a failed poll
 * means "gone", and the tile is honest about which of those it has seen.
 */
function useSleepTile(poll: { dataUpdatedAt: number; errorUpdatedAt: number; isError: boolean }) {
  const [phase, setPhase] = useState<SleepPhase>("idle");
  const fire = useCallback((event: SleepEvent) => setPhase((current) => nextSleepPhase(current, event)), []);

  const { dataUpdatedAt, errorUpdatedAt, isError } = poll;
  useEffect(() => {
    if (dataUpdatedAt) fire({ type: "answer" });
  }, [dataUpdatedAt, fire]);
  useEffect(() => {
    if (isError) fire({ type: "silence" });
  }, [isError, errorUpdatedAt, fire]);

  // A Mac that answers all the way through plainly did not go under; the tile lets go
  // rather than glowing at somebody for ever.
  useEffect(() => {
    if (phase !== "going") return;
    const timer = setTimeout(() => fire({ type: "timeout" }), SILENCE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [phase, fire]);

  const pulse = useRef(new Animated.Value(1)).current;
  const countdown = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!isSleepInFlight(phase)) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.25, duration: 550, useNativeDriver: false }),
        Animated.timing(pulse, { toValue: 1, duration: 550, useNativeDriver: false }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
      pulse.setValue(1);
    };
  }, [phase, pulse]);

  useEffect(() => {
    // `asking` gets a stub rather than a crawl: how long a request takes is the
    // network's business, and a bar that guesses would be inventing progress.
    if (phase === "asking") {
      countdown.setValue(0.12);
      return;
    }
    if (phase !== "going") {
      countdown.setValue(0);
      return;
    }
    // From here the length is known to the millisecond — the daemon waits exactly this
    // long before calling pmset — so the bar runs out as the Mac does.
    countdown.setValue(0.12);
    const run = Animated.timing(countdown, { toValue: 1, duration: SLEEP_DELAY_MS, useNativeDriver: false });
    run.start();
    return () => run.stop();
  }, [phase, countdown]);

  return { phase, fire, pulse, countdown };
}

/**
 * The link that wakes this Mac, and the one control on the page meant to be used when
 * the page itself is unreachable. So it is shown as text rather than as a button: the
 * point is to copy it once — into a shortcut, a bookmark, whatever the phone offers —
 * and press it months later, from a phone that cannot see Paseo because the Mac it runs
 * on is asleep.
 *
 * Pressing it here still opens it, which is how you check the anchor answers at all.
 * The address is the Mac's own on the local network, so the link only carries from
 * inside the house or through the VPN that puts you there.
 */
/**
 * Lid mode's tile: the one switch that changes a system setting rather than holding the Mac
 * from inside a process, so it always runs on a clock and shows how much is left. Before the
 * one-time permission is in place it offers that instead, in one press.
 */
function LidCard({
  status,
  theme,
  strings,
  now,
  busy,
  onPick,
  onForever,
  onStop,
  onDark,
  onSetup,
}: {
  status: Status;
  theme: PluginTheme;
  strings: Strings;
  now: number;
  busy: boolean;
  onPick(minutes: LidMinutes): void;
  onForever(): void;
  onStop(): void;
  onDark(value: boolean): void;
  onSetup(): void;
}) {
  const { lid } = status;
  const remainingMs = lid.until === "" ? 0 : Math.max(0, Date.parse(lid.until) - now);
  const lengthMs = lid.minutes * 60_000;
  const needsSetup = lid.setup === "needs-setup";
  const detail =
    needsSetup && !lid.on
      ? strings.lidSetup
      : lid.on
        ? lid.forever
          ? strings.lidOnForever
          : lid.until === ""
            ? strings.lidOnNoTimer
            : strings.lidOn(formatRemaining(remainingMs, strings))
        : strings.lidOff;
  const failed = lid.error !== "" && lid.error !== "needs-setup" ? strings.lidFailed(lid.error) : "";
  const endedNote = lid.on ? "" : lid.ended === "heat" ? strings.lidEndedHeat : lid.ended === "battery" ? strings.lidEndedBattery : "";

  return (
    <View style={{ flexDirection: "row" }}>
      <ModeCard icon={lid.on ? "LaptopMinimalCheck" : "LaptopMinimal"} title={strings.lidLabel} detail={detail} selected={lid.on} theme={theme} tile="100%">
        {lid.on && lid.until !== "" && lengthMs > 0 ? (
          <View style={{ height: 3, borderRadius: 2, backgroundColor: theme.colors.border, overflow: "hidden", marginTop: 4 }}>
            <View style={{ height: 3, backgroundColor: theme.colors.accent, width: `${Math.min(100, Math.round((remainingMs / lengthMs) * 100))}%` }} />
          </View>
        ) : null}
        <View style={{ flexDirection: "row", gap: 8, marginTop: 4, flexWrap: "wrap", opacity: busy ? 0.6 : 1 }}>
          {/* Presses are ignored while one is in flight: a "turn off" overtaken by a "turn on" is
              exactly the mix-up this tile cannot afford. */}
          {needsSetup ? (
            <Chip label={strings.lidSetupButton} selected={false} theme={theme} onPress={() => (busy ? undefined : onSetup())} />
          ) : (
            LID_MINUTES.map((minutes) => (
              <Chip
                key={minutes}
                label={formatRemaining(minutes * 60_000, strings)}
                selected={lid.on && lid.minutes === minutes}
                theme={theme}
                onPress={() => (busy ? undefined : onPick(minutes))}
              />
            ))
          )}
          {needsSetup ? null : (
            <Chip label={strings.lidForever} selected={lid.on && lid.forever} theme={theme} onPress={() => (busy ? undefined : onForever())} />
          )}
          {lid.on ? <Chip label={strings.lidStop} selected={false} theme={theme} onPress={() => (busy ? undefined : onStop())} /> : null}
        </View>
        {needsSetup ? null : (
          <View style={{ flexDirection: "row", marginTop: 4 }}>
            <Chip
              label={strings.lidDark}
              selected={lid.darkWhenClosed}
              theme={theme}
              onPress={() => (busy ? undefined : onDark(!lid.darkWhenClosed))}
            />
          </View>
        )}
        {endedNote !== "" ? <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>{endedNote}</Text> : null}
        {failed !== "" ? <Text style={{ color: theme.colors.statusDanger ?? theme.colors.foregroundMuted, fontSize: 12 }}>{failed}</Text> : null}
      </ModeCard>
    </View>
  );
}

function WakeLink({ url, theme, strings }: { url: string; theme: PluginTheme; strings: Strings }) {
  if (!url) {
    return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, textAlign: "center" }}>{strings.wakeMissing}</Text>;
  }
  return (
    <View style={{ alignItems: "center", gap: 4 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{strings.wakeHint}</Text>
      <Text
        selectable
        accessibilityRole="link"
        onPress={() => void Linking.openURL(url).catch(() => undefined)}
        style={{ color: theme.colors.accent, fontSize: 13 }}
      >
        {url}
      </Text>
    </View>
  );
}

export function CaffeineSurface({ theme, layout }: PluginSurfaceProps) {
  const strings = t(detectAppLocale());
  const now = useNow();
  const fetchStatus = useRpc(getStatus);
  const applyMode = useRpc(setMode);
  const applyOptions = useRpc(setOptions);
  const askSleep = useRpc(sleepNow);
  const askLid = useRpc(setLid);
  const askLidSetup = useRpc(setupLid);
  const queryClient = useQueryClient();

  const { data, isLoading, isError, dataUpdatedAt, errorUpdatedAt } = useQuery({
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

  const changeOptions = useMutation({
    mutationFn: (patch: SetOptionsInput) => applyOptions(patch),
    onSuccess: (status) => queryClient.setQueryData(QUERY_KEY, status),
  });

  const askLidDisplay = useRpc(setLidDisplay);
  const lidDisplay = useMutation({
    mutationFn: (darkWhenClosed: boolean) => askLidDisplay({ darkWhenClosed }),
    onSuccess: (status) => queryClient.setQueryData(QUERY_KEY, status),
  });

  const lid = useMutation({
    mutationFn: (input: Parameters<typeof askLid>[0]) => askLid(input),
    onSuccess: (status) => queryClient.setQueryData(QUERY_KEY, status),
  });

  // The password dialog shows on the Mac and waits for a person, so this one can take minutes.
  const lidSetupRun = useMutation({
    mutationFn: () => askLidSetup({}),
    onSuccess: (status) => queryClient.setQueryData(QUERY_KEY, status),
  });

  // No optimistic status and nothing written back: the answer describes a Mac that is
  // about to suspend, and what happens next is told by the poll going quiet rather than
  // by anything this request returns.
  const tile = useSleepTile({ dataUpdatedAt, errorUpdatedAt, isError });
  const sleep = useMutation({
    mutationFn: () => askSleep({}),
    onMutate: () => tile.fire({ type: "press" }),
    onSuccess: () => tile.fire({ type: "answered" }),
    onError: () => tile.fire({ type: "refused" }),
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

          {/* A row each: one has a sentence to finish, the other six chips to lay out.
              The row is what makes tile="100%" mean a width. ModeCard's flexBasis resolves
              against its parent's main axis, and the content container's runs down the page,
              so a card left as a direct child there is stretched to the full scroll height. */}
          <View style={{ flexDirection: "row" }}>
            <ModeCard
              icon="Zap"
              title={strings.auto}
              detail={strings.autoDetail}
              selected={data.mode === "auto"}
              theme={theme}
              tile="100%"
              onPress={() => change.mutate({ mode: "auto" })}
            />
          </View>

          <View style={{ flexDirection: "row" }}>
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
          </View>

          {/* Tiles rather than SettingsSwitch rows: in half a phone's width the host's switch
              wraps its label, wraps its hint, and drops the toggle onto a line of its own. These
              are the same tiles as the modes, and being on is shown the same way — by the border. */}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: m.gap }}>
            <ModeCard
              icon={data.keepDisplay ? "Monitor" : "MonitorOff"}
              title={strings.displayLabel}
              detail={strings.displayState(data.keepDisplay)}
              selected={data.keepDisplay}
              theme={theme}
              tile={m.tile}
              onPress={() => changeOptions.mutate({ keepDisplay: !data.keepDisplay })}
            />
            <ModeCard
              icon={tile.phase === "asleep" ? "MoonStar" : "Moon"}
              title={tile.phase === "asleep" ? strings.sleptLabel : strings.sleepLabel}
              detail={sleepDetailFor(tile.phase, strings)}
              selected={tile.phase !== "idle"}
              theme={theme}
              tile={m.tile}
              iconPulse={tile.pulse}
              onPress={() => sleep.mutate()}
            >
              {isSleepInFlight(tile.phase) ? (
                <View style={{ height: 3, borderRadius: 2, backgroundColor: theme.colors.border, overflow: "hidden", marginTop: 4 }}>
                  <Animated.View
                    style={{
                      height: 3,
                      backgroundColor: theme.colors.accent,
                      width: tile.countdown.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }),
                    }}
                  />
                </View>
              ) : null}
            </ModeCard>
          </View>

          <LidCard
            status={data}
            theme={theme}
            strings={strings}
            now={now}
            busy={lid.isPending || lidSetupRun.isPending || lidDisplay.isPending}
            onPick={(minutes) => lid.mutate({ lid: "on", minutes })}
            onForever={() => lid.mutate({ lid: "forever" })}
            onDark={(darkWhenClosed) => lidDisplay.mutate(darkWhenClosed)}
            onStop={() => lid.mutate({ lid: "off" })}
            onSetup={() => lidSetupRun.mutate()}
          />

          <WakeLink url={data.wakeUrl} theme={theme} strings={strings} />
        </>
      )}
    </ScrollView>
  );
}
