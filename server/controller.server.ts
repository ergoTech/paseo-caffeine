import type { Battery, LidStatus, SetInput, SetOptionsInput, Status, WarmupStatus } from "../shared/caffeine.shared.ts";
import type { Keeper } from "./keeper.server.ts";
import { TICK_MS, type Stored, decide, defaultStored, nextBusyUntil, untilForMinutes } from "./policy.ts";

export interface ControllerDeps {
  read(): Promise<Stored>;
  write(stored: Stored): Promise<void>;
  keeper: Keeper;
  runningCount(): Promise<number | null>;
  /** The battery, read once per tick; null on a machine that has none. */
  readBattery?(): Promise<Battery | null>;
  /** The link that wakes this Mac, re-read on every snapshot because the address moves. */
  wakeUrl?(): string;
  /** Orders the Mac under; absent in tests that have no business suspending anything. */
  sleepNow?(): void;
  /** Lid mode, checked on the same tick; absent in tests that do not touch it. */
  lid?: { tick(battery: Battery | null): Promise<void>; status(): LidStatus };
  /** Session warm-up, checked on the same tick; absent in tests that do not touch it. */
  warmup?: { tick(): Promise<void>; status(): WarmupStatus };
  now?: () => number;
  tickMs?: number;
  log?: (line: string) => void;
}

export interface Controller {
  start(): Promise<void>;
  stop(): void;
  status(): Status;
  set(input: SetInput): Promise<Status>;
  setOptions(patch: SetOptionsInput): Promise<Status>;
  /** Snapshots first, then asks for sleep: the answer has to outrun the suspend. */
  sleep(): Status;
  tick(): Promise<Status>;
}

/**
 * One tick: ask about agents, move the busy window, decide, reconcile the child. The
 * same routine runs on a timer and right after every `set`, so a switch is felt at once
 * and a timer expires within TICK_MS of its deadline.
 */
export function createController(deps: ControllerDeps): Controller {
  const now = deps.now ?? Date.now;
  const tickMs = deps.tickMs ?? TICK_MS;
  const log = deps.log ?? (() => undefined);

  let stored: Stored = defaultStored();
  let busyUntil = 0;
  let agents = 0;
  let battery: Battery | null = null;
  let lastReason = "";
  let tickAt = "";
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  function snapshot(): Status {
    return {
      mode: stored.mode,
      until: stored.until,
      active: deps.keeper.active(),
      busy: now() < busyUntil,
      agents,
      error: deps.keeper.error(),
      tickAt,
      keepDisplay: stored.keepDisplay,
      wakeUrl: deps.wakeUrl?.() ?? "",
      battery,
      lid: deps.lid?.status() ?? { on: false, until: "", minutes: 0, setup: "unknown", error: "" },
      warmup: deps.warmup?.status() ?? { enabled: false, time: "06:00", nextAt: "", lastAt: "", results: [], running: false },
    };
  }

  async function reconcile(): Promise<Status> {
    const nowMs = now();
    const running = await deps.runningCount();
    agents = running ?? 0;
    // The battery has no say in whether the Mac stays awake; it is read here only
    // because this is the one place that already runs on a timer.
    if (deps.readBattery) battery = await deps.readBattery();
    // Lid mode ends at its deadline or on a low battery whatever the mode says.
    if (deps.lid) await deps.lid.tick(battery).catch((failure) => log(`caffeine: lid check failed: ${String(failure)}`));
    // Not awaited: a warm-up runs `claude` once per login, which takes seconds, and the tick
    // that decides whether the Mac stays awake must not wait on it.
    if (deps.warmup) void deps.warmup.tick().catch((failure) => log(`caffeine: warm-up failed: ${String(failure)}`));
    busyUntil = nextBusyUntil(busyUntil, running, nowMs);

    const decision = decide(stored, nowMs, busyUntil);
    if (decision.stored !== stored) {
      stored = decision.stored;
      await deps.write(stored);
    }

    if (decision.active) {
      deps.keeper.hold(stored.mode === "timer" ? Date.parse(stored.until) : undefined, stored.keepDisplay);
    } else {
      deps.keeper.release();
    }

    if (decision.reason !== lastReason) {
      log(`caffeine: ${decision.reason} (active=${decision.active}, agents=${agents})`);
      lastReason = decision.reason;
    }
    tickAt = new Date(nowMs).toISOString();
    return snapshot();
  }

  return {
    async start() {
      stored = await deps.read();
      await reconcile();
      timer = setInterval(() => {
        if (!stopped) void reconcile().catch((error) => log(`caffeine: tick failed: ${String(error)}`));
      }, tickMs);
    },

    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      deps.keeper.release();
    },

    status: snapshot,

    async set(input) {
      // The display choice rides through a mode change untouched: it is a property of
      // the machine the user is sitting at, not of why the Mac is being kept awake.
      const next: Stored =
        input.mode === "timer"
          ? { mode: "timer", until: untilForMinutes(now(), input.minutes), keepDisplay: stored.keepDisplay }
          : { mode: input.mode, until: "", keepDisplay: stored.keepDisplay };
      // A different deadline or a different mode needs a child with different
      // arguments, so the old one goes first and reconcile() starts the right one.
      if (next.mode !== stored.mode || next.until !== stored.until) deps.keeper.release();
      stored = next;
      await deps.write(stored);
      return reconcile();
    },

    async setOptions(patch) {
      const next: Stored = { ...stored, keepDisplay: patch.keepDisplay ?? stored.keepDisplay };
      if (next.keepDisplay === stored.keepDisplay) return reconcile();
      // caffeinate cannot be told to drop -d while it runs, so the child goes and
      // reconcile() starts one with the right arguments.
      deps.keeper.release();
      stored = next;
      await deps.write(stored);
      return reconcile();
    },

    /**
     * The hold goes first, and it has to. `caffeinate -s` outranks `pmset sleepnow`:
     * under a hold the Mac drops to DarkWake and sits there, awake in every way that
     * costs power, until the hold ends of its own accord. Measured on this machine —
     * `sleepnow` at 23:34:28 gave "Entering DarkWake state", and the real "Entering
     * Sleep state" arrived at 23:40:40, six minutes later, when caffeinate let go.
     *
     * Killing the child is enough; the mode is left alone. Sleeping is an act rather
     * than a mode, so the Mac comes back under the same policy it went under with and
     * the next tick takes the hold again — which matters, because a Mac woken by the
     * link would otherwise have a minute of idle before macOS put it straight back.
     *
     * The second the sleeper waits before calling pmset is also the second the child
     * needs to die in.
     */
    sleep() {
      deps.keeper.release();
      log(`caffeine: sleep asked for (was ${stored.mode}, hold released)`);
      deps.sleepNow?.();
      return snapshot();
    },

    tick: reconcile,
  };
}
