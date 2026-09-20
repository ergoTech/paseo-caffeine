import { execFile } from "node:child_process";

const PMSET = "/usr/bin/pmset";

/**
 * How long the reply gets before the Mac goes under. `pmset sleepnow` suspends the
 * machine in well under a second, and a request that arrives from a phone over the
 * network dies with the connection it came on — so the answer leaves first and the Mac
 * sleeps after, rather than the caller watching a spinner until it gives up.
 */
export const SLEEP_DELAY_MS = 1_000;

export interface Sleeper {
  /** Returns at once; the Mac goes under a moment later. */
  request(): void;
  /** The last failure to run pmset, or "" while all is well. */
  error(): string;
}

export interface SleeperOptions {
  delayMs?: number;
  run?: (command: string, args: readonly string[]) => Promise<void>;
  schedule?: (fn: () => void, ms: number) => void;
}

function runPmset(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], (error) => (error ? reject(error) : resolve()));
  });
}

/**
 * The counterpart to the keeper: that one argues with macOS about staying awake, this one
 * ends the argument. Nothing here releases the keeper first — a held Mac told to sleep
 * still sleeps, because `pmset sleepnow` is an order rather than a request, and the hold
 * goes back to work on the other side of the wake.
 */
export function createSleeper(options: SleeperOptions = {}): Sleeper {
  const delayMs = options.delayMs ?? SLEEP_DELAY_MS;
  const run = options.run ?? runPmset;
  const schedule = options.schedule ?? ((fn, ms) => void setTimeout(fn, ms).unref?.());

  let failure = "";

  return {
    request() {
      failure = "";
      schedule(() => {
        void run(PMSET, ["sleepnow"]).catch((error: unknown) => {
          failure = error instanceof Error ? error.message : String(error);
        });
      }, delayMs);
    },

    error: () => failure,
  };
}
