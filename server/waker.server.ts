import { type ChildProcess, execFileSync, spawn as nodeSpawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import type { Server } from "node:net";
import { hostname, networkInterfaces } from "node:os";

/**
 * The port the wake anchor listens on. Fixed rather than ephemeral, because the whole
 * point is a link you save once on the phone and press months later. 9999 is high enough
 * to need no root and is not on the list of ports browsers refuse to open — 22 and 5900
 * both are, which is why neither could be the link.
 */
export const WAKE_PORT = 9999;

/**
 * Bonjour is the part that matters. A sleeping Mac hands its registered services to the
 * sleep proxy on the network — an Apple TV or a HomePod — and the proxy answers ARP on
 * its behalf and sends a magic packet when someone knocks on one of those ports. A
 * listening socket nobody announced is invisible to that machinery, so the announcement,
 * not the socket, is what wakes the Mac.
 *
 * The type is under the fifteen characters mDNSResponder allows, and `local` is spelled
 * out rather than left as `.` so the command reads the same as the one in the logs.
 */
const SERVICE_TYPE = "_caffeine-wake._tcp";
const SERVICE_DOMAIN = "local";
const DNS_SD = "/usr/bin/dns-sd";
const PKILL = "/usr/bin/pkill";

/** What a probe needs from the machine: enough for tests to hand in a stand-in. */
type Interfaces = ReturnType<typeof networkInterfaces>;
type Child = Pick<ChildProcess, "pid" | "kill" | "on" | "stdout" | "stderr">;
type Spawner = (command: string, args: readonly string[]) => Child;

export interface Waker {
  /** `http://<address>:<port>`, or "" while there is no anchor to link to. */
  url(): string;
  /** The last failure to listen or to announce, or "" while all is well. */
  error(): string;
  start(): Promise<void>;
  stop(): void;
}

export interface WakerOptions {
  port?: number;
  name?: string;
  interfaces?: () => Interfaces;
  spawn?: Spawner;
  listen?: () => Server;
  /** The page a browser gets; the default says the host is awake and nothing else. */
  render?: () => string;
  /** Clears announcements left by an earlier life of this plugin. */
  reap?: () => void;
}

/**
 * Which address to put in the link. A MacBook has a pile of interfaces — `utun` for every
 * VPN, `anpi` and `bridge` for the internal fabric, `llw0` and `awdl0` for AirDrop — and
 * only one of them is the address the phone can reach: the Wi-Fi one. `en` interfaces
 * come first and in order, so `en0` wins on a laptop and a Thunderbolt adapter only gets
 * a say when Wi-Fi is down.
 *
 * Link-local 169.254 addresses are dropped even when they sit on an `en`: they belong to
 * an interface that never got a lease, and a link to one leads nowhere.
 */
export function localAddress(interfaces: Interfaces): string {
  const candidates: { name: string; address: string }[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      // Node 18 reports the family as the number 4; later versions as the string "IPv4".
      const isV4 = entry.family === "IPv4" || (entry.family as unknown as number) === 4;
      if (!isV4 || entry.internal) continue;
      if (entry.address.startsWith("169.254.")) continue;
      candidates.push({ name, address: entry.address });
    }
  }
  if (candidates.length === 0) return "";

  const ethernet = candidates
    .filter((candidate) => /^en\d+$/.test(candidate.name))
    .sort((a, b) => Number(a.name.slice(2)) - Number(b.name.slice(2)));
  return (ethernet[0] ?? candidates[0]).address;
}

/** The exact command line `announce` builds, which is what makes the reaper precise. */
export function announcement(name: string, port: number): string {
  return `${DNS_SD} -R ${name} ${SERVICE_TYPE} ${SERVICE_DOMAIN} ${port}`;
}

/**
 * Kills `dns-sd`s this plugin started in an earlier life. Matched on the whole command
 * line, so it can only ever hit an announcement with this plugin's own service type —
 * and pkill exiting non-zero just means there were none, which is the ordinary case.
 */
function reapOrphans(name: string, port: number): void {
  try {
    execFileSync(PKILL, ["-f", announcement(name, port)], { stdio: "ignore" });
  } catch {
    // Nothing matched, or pkill is missing on a machine that is not a Mac. Either way
    // the announcement that follows is the one that matters.
  }
}

/**
 * The anchor: a small web server, and a `dns-sd -R` telling the network it exists. By the
 * time a client connects the Mac is already awake — the proxy woke it to deliver the
 * packet — so the page is a receipt rather than a service, and there is nothing here to
 * authenticate: a knock is a knock, and the damage anyone within reach of the network can
 * do with it is to wake a Mac that was asleep.
 *
 * `dns-sd` has no `-w` to tie it to this process the way `caffeinate` has, and leaning on
 * a broken stdout pipe does not work either: it goes quiet after the registration line
 * and so never writes into the broken pipe that would kill it. Two reloads, two live
 * `dns-sd`s, both advertising the same port — seen exactly that way. So each start reaps
 * the announcements of its own past lives by their command line before making a new one.
 */
export function createWaker(options: WakerOptions = {}): Waker {
  const port = options.port ?? WAKE_PORT;
  const name = options.name ?? "Caffeine";
  const readInterfaces = options.interfaces ?? networkInterfaces;
  const spawn = options.spawn ?? ((command, args) => nodeSpawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] }));
  const render = options.render ?? (() => `${hostname()} is awake.\n`);
  const reap = options.reap ?? (() => reapOrphans(name, port));
  const listen =
    options.listen ??
    (() => {
      const http = createHttpServer((_request, response) => {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          // The page describes a moment — which Mac woke, when, on what power. A cached
          // copy of it is a lie the next time the link is pressed.
          "cache-control": "no-store",
        });
        response.end(render());
      });
      // Clients here hang up mid-request as a matter of course: a shortcut with a
      // one-second timeout, a browser that gave up, a `curl -m 2`. Node turns that into
      // an `error` on the socket, and unhandled it takes the whole plugin down — seen
      // exactly that way, one curl and `read ECONNRESET` in the daemon log.
      http.on("clientError", (_error, socket) => socket.destroy());
      http.on("connection", (socket) => socket.on("error", () => undefined));
      return http;
    });

  let server: Server | null = null;
  let child: Child | null = null;
  let failure = "";

  function announce(): void {
    if (child) return;
    try {
      // Before, never after: the pattern would match the child we are about to start.
      reap();
      const started = spawn(DNS_SD, ["-R", name, SERVICE_TYPE, SERVICE_DOMAIN, String(port)]);
      child = started;
      // Drained rather than ignored: dns-sd narrates every registration, and a pipe left
      // unread fills up and stops the process that is supposed to be holding the
      // announcement open.
      started.stdout?.resume();
      started.stderr?.resume();
      started.on("exit", () => {
        if (child === started) child = null;
      });
      started.on("error", (error: Error) => {
        if (child === started) child = null;
        failure = error.message;
      });
    } catch (error) {
      child = null;
      failure = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    url() {
      if (!server) return "";
      const address = localAddress(readInterfaces());
      return address ? `http://${address}:${port}` : "";
    },

    error: () => failure,

    start() {
      if (server) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const candidate = listen();
        // A port already taken is the one failure worth surfacing: the link would point
        // at somebody else's service. The plugin carries on holding the Mac awake — the
        // anchor is the extra, not the job.
        const onStartupError = (error: Error) => {
          failure = error.message;
          server = null;
          resolve();
        };
        candidate.once("error", onStartupError);
        candidate.listen(port, () => {
          candidate.off("error", onStartupError);
          // Whatever goes wrong later — a descriptor limit, an interface pulled out from
          // under the socket — is recorded rather than thrown. An unhandled `error` on
          // the server ends the plugin, and losing the anchor must not cost the Mac the
          // hold that keeps it awake.
          candidate.on("error", (error: Error) => {
            failure = error.message;
          });
          server = candidate;
          failure = "";
          announce();
          resolve();
        });
      });
    },

    stop() {
      child?.kill();
      child = null;
      server?.close();
      server = null;
    },
  };
}
