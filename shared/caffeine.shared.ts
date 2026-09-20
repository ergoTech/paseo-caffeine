import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const mode = z.enum(["off", "on", "timer", "auto"]);
/** Minutes rather than hours: the shortest hold is half of one. */
export const timerMinutes = z.union([
  z.literal(30),
  z.literal(60),
  z.literal(120),
  z.literal(180),
  z.literal(480),
  z.literal(720),
]);

/**
 * What the Mac's own battery says. Absent on a machine without one, which is why every
 * client has to cope with null rather than with a zero percent charge.
 */
export const battery = z.object({
  percent: z.number().int().min(0).max(100),
  charging: z.boolean(),
  /** Charged and still on the charger: neither filling nor draining. */
  charged: z.boolean(),
  external: z.boolean(),
  /** Minutes until empty, or until full while charging; null when there is no estimate. */
  minutes: z.number().int().nonnegative().nullable(),
});

/** What every client sees. `until` and `tickAt` are RFC 3339 or empty. */
export const status = z.object({
  mode,
  until: z.string().default(""),
  active: z.boolean(),
  busy: z.boolean(),
  agents: z.number().int().nonnegative(),
  error: z.string().default(""),
  tickAt: z.string().default(""),
  /** Whether the display is held awake along with the system. */
  keepDisplay: z.boolean().default(false),
  /**
   * The link that wakes this Mac from the local network, or "" when the anchor could not
   * be raised. Carried in the status rather than fetched on its own, because the address
   * in it changes with the network and the surface already re-reads this every five
   * seconds.
   */
  wakeUrl: z.string().default(""),
  battery: battery.nullable().default(null),
});

export const setInput = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("off") }),
  z.object({ mode: z.literal("on") }),
  z.object({ mode: z.literal("auto") }),
  z.object({ mode: z.literal("timer"), minutes: timerMinutes }),
]);

/** A patch: whatever is left out keeps the value it already had. */
export const setOptionsInput = z.object({
  keepDisplay: z.boolean().optional(),
});

export type Mode = z.output<typeof mode>;
export type Status = z.output<typeof status>;
export type SetInput = z.output<typeof setInput>;
export type SetOptionsInput = z.output<typeof setOptionsInput>;
export type Battery = z.output<typeof battery>;

export const getStatus = defineRpc({
  name: "caffeine.get",
  input: z.object({}),
  output: status,
});

export const setMode = defineRpc({
  name: "caffeine.set",
  input: setInput,
  output: status,
});

/**
 * Separate from `setMode` on purpose: the display switch is orthogonal to the mode, and
 * folding it into that discriminated union would make every mode change carry it from
 * the client — and eventually drop it.
 */
export const setOptions = defineRpc({
  // Lower case only: the SDK matches method names against /^[a-z][a-z0-9._-]*$/ and
  // throws on a capital, which takes the whole plugin down at import time.
  name: "caffeine.set-options",
  input: setOptionsInput,
  output: status,
});

/**
 * The other direction: not a mode that outlives the call, but one act. The status comes
 * back describing the Mac a second before it goes under — by design, since the caller is
 * usually a phone that is about to lose the connection anyway and wants to know the
 * request was taken, not what the machine looks like while it suspends.
 */
/**
 * How long the Mac gets after answering before it actually suspends. Shared rather than
 * server-side only, because the client counts down the same second on screen — a bar
 * that finishes early or late reads as a lie about what the machine is doing.
 */
export const SLEEP_DELAY_MS = 1_000;

export const sleepNow = defineRpc({
  name: "caffeine.sleep",
  input: z.object({}),
  output: status,
});
