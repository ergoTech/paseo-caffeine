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
  battery: battery.nullable().default(null),
});

export const setInput = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("off") }),
  z.object({ mode: z.literal("on") }),
  z.object({ mode: z.literal("auto") }),
  z.object({ mode: z.literal("timer"), minutes: timerMinutes }),
]);

export const setDisplayInput = z.object({ keepDisplay: z.boolean() });

export type Mode = z.output<typeof mode>;
export type Status = z.output<typeof status>;
export type SetInput = z.output<typeof setInput>;
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
 * Separate from `setMode` on purpose: holding the display is orthogonal to the mode, and
 * folding it into that discriminated union would make every mode change carry the flag
 * from the client — and eventually drop it.
 */
export const setDisplay = defineRpc({
  // Lower case only: the SDK matches method names against /^[a-z][a-z0-9._-]*$/ and
  // throws on a capital, which takes the whole plugin down at import time.
  name: "caffeine.set-display",
  input: setDisplayInput,
  output: status,
});
