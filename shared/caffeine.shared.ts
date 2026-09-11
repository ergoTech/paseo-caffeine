import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const mode = z.enum(["off", "on", "timer", "auto"]);
export const hours = z.union([z.literal(1), z.literal(3), z.literal(8)]);

/** What every client sees. `until` and `tickAt` are RFC 3339 or empty. */
export const status = z.object({
  mode,
  until: z.string().default(""),
  active: z.boolean(),
  busy: z.boolean(),
  agents: z.number().int().nonnegative(),
  error: z.string().default(""),
  tickAt: z.string().default(""),
});

export const setInput = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("off") }),
  z.object({ mode: z.literal("on") }),
  z.object({ mode: z.literal("auto") }),
  z.object({ mode: z.literal("timer"), hours }),
]);

export type Mode = z.output<typeof mode>;
export type Status = z.output<typeof status>;
export type SetInput = z.output<typeof setInput>;

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
