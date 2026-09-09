import type { PaseoApi } from "@getpaseo/client";

/*
 * Two questions this file exists to answer, once, from the plugin log:
 *
 * 1. Does server code started from contribute() behind a guard run on the daemon
 *    without breaking the client bundle? If it does, "probe: server side alive" is
 *    logged shortly after install.
 * 2. Does the `paseo` object handed to a handler keep working outside that request?
 *    If it does, "probe: agents outside request" lines keep appearing every 20s
 *    after the surface has been opened once.
 */
let remembered: PaseoApi | null = null;

export function startProbe(): () => void {
  console.log("probe: server side alive");
  const timer = setInterval(async () => {
    if (!remembered) {
      console.log("probe: no paseo yet");
      return;
    }
    try {
      const result = await remembered.agents.list();
      console.log(`probe: agents outside request -> ${result.entries.length} entries`);
    } catch (error) {
      console.log(`probe: agents outside request FAILED -> ${String(error)}`);
    }
  }, 20_000);
  return () => clearInterval(timer);
}

export function rememberPaseo(paseo: PaseoApi): void {
  remembered = paseo;
}
