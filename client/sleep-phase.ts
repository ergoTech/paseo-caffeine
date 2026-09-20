/**
 * What the Sleep tile is doing, as a little machine of its own.
 *
 * Sleeping is the one action on this page whose result cannot be reported by the thing
 * performing it: the Mac suspends, and with it the daemon that would have said so. So
 * the tile reads the absence instead — the status poll behind the surface stops being
 * answered, and that silence is the only honest confirmation there is.
 *
 * Kept apart from the component because it is the part worth testing, and a plugin
 * surface cannot be rendered in `node --test`.
 */
export type SleepPhase =
  /** Nothing doing. */
  | "idle"
  /** The request is in flight. Short — the daemon answers before it suspends. */
  | "asking"
  /** Answered: the Mac is counting down its last second, then the machine goes. */
  | "going"
  /** It stopped answering. As far as anything here can tell, it is asleep. */
  | "asleep";

export type SleepEvent =
  | { type: "press" }
  | { type: "answered" }
  | { type: "refused" }
  /** A status poll failed — over a connection to the Mac itself, that means gone. */
  | { type: "silence" }
  /** A status poll came back. The Mac is plainly still here. */
  | { type: "answer" }
  /** Long enough in `going` with the Mac still answering that it plainly did not go. */
  | { type: "timeout" };

/**
 * How long `going` waits for silence before deciding the sleep did not happen. Generous
 * on purpose: the poll runs every five seconds and react-query retries before it reports
 * a failure, so a Mac that went under quietly can take a good ten seconds to be missed.
 * Ending the wait early would flash "did not sleep" at somebody holding a dark laptop.
 */
export const SILENCE_TIMEOUT_MS = 20_000;

export function nextSleepPhase(phase: SleepPhase, event: SleepEvent): SleepPhase {
  switch (event.type) {
    case "press":
      return "asking";
    case "answered":
      return phase === "asking" ? "going" : phase;
    case "refused":
      return "idle";
    case "silence":
      // Only meaningful while a sleep is expected. Silence at any other moment is the
      // network being the network — a closed lid, a switched Wi-Fi — and the tile has
      // no business calling that a sleep it caused.
      return phase === "asking" || phase === "going" ? "asleep" : phase;
    case "answer":
      // The Mac is back, or never left. Either way the tile is free again — but only
      // once it has been asleep: an answer still arriving during `going` is just the
      // poll that overlapped the request.
      return phase === "asleep" ? "idle" : phase;
    case "timeout":
      return phase === "going" ? "idle" : phase;
  }
}

/** Whether the tile should be showing its countdown bar and pulsing. */
export function isSleepInFlight(phase: SleepPhase): boolean {
  return phase === "asking" || phase === "going";
}
