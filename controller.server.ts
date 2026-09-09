import type { SetInput, Status } from "./caffeine.shared.ts";
import type { Keeper } from "./keeper.server.ts";
import { TICK_MS, type Stored, decide, defaultStored, nextBusyUntil, untilForHours } from "./policy.ts";

export interface ControllerDeps {
  read(): Promise<Stored>;
  write(stored: Stored): Promise<void>;
  keeper: Keeper;
  runningCount(): Promise<number | null>;
  now?: () => number;
  tickMs?: number;
  log?: (line: string) => void;
}

export interface Controller {
  start(): Promise<void>;
  stop(): void;
  status(): Status;
  set(input: SetInput): Promise<Status>;
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
    };
  }

  async function reconcile(): Promise<Status> {
    const nowMs = now();
    const running = await deps.runningCount();
    agents = running ?? 0;
    busyUntil = nextBusyUntil(busyUntil, running, nowMs);

    const decision = decide(stored, nowMs, busyUntil);
    if (decision.stored !== stored) {
      stored = decision.stored;
      await deps.write(stored);
    }

    if (decision.active) {
      deps.keeper.hold(stored.mode === "timer" ? Date.parse(stored.until) : undefined);
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
      const next: Stored =
        input.mode === "timer"
          ? { mode: "timer", until: untilForHours(now(), input.hours) }
          : { mode: input.mode, until: "" };
      // A different deadline or a different mode needs a child with different
      // arguments, so the old one goes first and reconcile() starts the right one.
      if (next.mode !== stored.mode || next.until !== stored.until) deps.keeper.release();
      stored = next;
      await deps.write(stored);
      return reconcile();
    },

    tick: reconcile,
  };
}
