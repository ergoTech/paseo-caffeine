import type { Battery, SetInput, Status } from "../shared/caffeine.shared.ts";
import type { Keeper } from "./keeper.server.ts";
import { TICK_MS, type Stored, decide, defaultStored, nextBusyUntil, untilForMinutes } from "./policy.ts";

export interface ControllerDeps {
  read(): Promise<Stored>;
  write(stored: Stored): Promise<void>;
  keeper: Keeper;
  runningCount(): Promise<number | null>;
  /** The battery, read once per tick; null on a machine that has none. */
  readBattery?(): Promise<Battery | null>;
  now?: () => number;
  tickMs?: number;
  log?: (line: string) => void;
}

export interface Controller {
  start(): Promise<void>;
  stop(): void;
  status(): Status;
  set(input: SetInput): Promise<Status>;
  setDisplay(keepDisplay: boolean): Promise<Status>;
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
      battery,
    };
  }

  async function reconcile(): Promise<Status> {
    const nowMs = now();
    const running = await deps.runningCount();
    agents = running ?? 0;
    // The battery has no say in whether the Mac stays awake; it is read here only
    // because this is the one place that already runs on a timer.
    if (deps.readBattery) battery = await deps.readBattery();
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

    async setDisplay(keepDisplay) {
      if (keepDisplay === stored.keepDisplay) return reconcile();
      // caffeinate cannot be told to drop -d while it runs, and hold() will not touch a
      // child that is already up, so the old one goes and reconcile() starts its replacement.
      deps.keeper.release();
      stored = { ...stored, keepDisplay };
      await deps.write(stored);
      return reconcile();
    },

    tick: reconcile,
  };
}
