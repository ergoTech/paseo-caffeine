import { execFile } from "node:child_process";
import type { Battery } from "../shared/caffeine.shared.ts";

/** Reading `pmset -g batt` costs a few milliseconds, so a tick can afford it. */
const PMSET = "/usr/bin/pmset";
const ARGS = ["-g", "batt"] as const;

/**
 * `pmset -g batt` prints the power source on one line and, on a machine that has a
 * battery, one line per battery:
 *
 *     Now drawing from 'AC Power'
 *      -InternalBattery-0 (id=34930787)	100%; charged; 0:00 remaining present: true
 *
 * The state word is whatever pmset feels like — "charging", "discharging", "charged",
 * "AC attached; not charging", "finishing charge" — so it is matched by what it
 * contains rather than by equality. A desktop prints the first line and nothing else,
 * and gets null.
 */
export function parseBattery(text: string): Battery | null {
  const percentMatch = text.match(/(\d{1,3})%/);
  if (!percentMatch) return null;
  const percent = Math.min(100, Number(percentMatch[1]));

  const external = /drawing from ['"]AC Power['"]/i.test(text);
  const charging = /;\s*charging/i.test(text) || /finishing charge/i.test(text);
  // "charged" and "AC attached; not charging" both mean a full-ish battery that is
  // neither filling nor draining, and both should read as resting on the charger.
  const charged = /;\s*charged/i.test(text) || /not charging/i.test(text);

  // 0:00 accompanies "charged", where it means "not applicable" rather than "no time
  // left", and "(no estimate)" appears while pmset is still working it out.
  const timeMatch = text.match(/(\d+):(\d{2})\s+remaining/);
  let minutes: number | null = null;
  if (timeMatch) {
    const total = Number(timeMatch[1]) * 60 + Number(timeMatch[2]);
    if (total > 0) minutes = total;
  }

  return { percent, charging, charged, external, minutes };
}

export interface BatteryProbe {
  /** The battery now, or null on a machine without one or when pmset will not answer. */
  read(): Promise<Battery | null>;
}

type Runner = () => Promise<string>;

function runPmset(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(PMSET, [...ARGS], { timeout: 5_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

export function createBatteryProbe(run: Runner = runPmset): BatteryProbe {
  return {
    async read() {
      try {
        return parseBattery(await run());
      } catch {
        // A battery that cannot be read is simply not shown; it has no say in whether
        // the Mac stays awake, so there is nothing to resolve towards.
        return null;
      }
    },
  };
}
