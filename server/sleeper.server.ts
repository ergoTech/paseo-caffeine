import { execFile } from "node:child_process";
import { SLEEP_DELAY_MS } from "../shared/caffeine.shared.ts";

const PMSET = "/usr/bin/pmset";

export { SLEEP_DELAY_MS };

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
  log?: (line: string) => void;
}

function runPmset(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], (error) => (error ? reject(error) : resolve()));
  });
}

/**
 * The counterpart to the keeper: that one argues with macOS about staying awake, this one
 * ends the argument. Releasing the hold is the caller's job and is not optional —
 * `pmset sleepnow` under a live `caffeinate -s` buys a DarkWake and nothing more. The
 * delay below doubles as the window the released child needs to actually exit.
 */
export function createSleeper(options: SleeperOptions = {}): Sleeper {
  const delayMs = options.delayMs ?? SLEEP_DELAY_MS;
  const run = options.run ?? runPmset;
  // Deliberately not unref'd. The timer is the only thing standing between a request and
  // a suspended Mac, and a timer that does not hold the loop open is a sleep that may
  // never be asked for.
  const schedule = options.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
  const log = options.log ?? (() => undefined);

  let failure = "";

  return {
    request() {
      failure = "";
      log(`caffeine: sleeping in ${delayMs} ms`);
      schedule(() => {
        void run(PMSET, ["sleepnow"])
          .then(() => log("caffeine: pmset sleepnow returned"))
          .catch((error: unknown) => {
            failure = error instanceof Error ? error.message : String(error);
            log(`caffeine: pmset sleepnow failed: ${failure}`);
          });
      }, delayMs);
    },

    error: () => failure,
  };
}
