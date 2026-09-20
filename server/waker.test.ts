import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, createServer } from "node:net";
import { WAKE_PORT, announcement, createWaker, localAddress } from "./waker.server.ts";

/** A port high enough that nothing else on a developer's Mac is sitting on it. */
const PORT = 47_311;

type Interfaces = Parameters<typeof localAddress>[0];

function child() {
  const calls: string[][] = [];
  const reaped: number[] = [];
  let killed = 0;
  const spawn = (command: string, args: readonly string[]) => {
    calls.push([command, ...args]);
    return {
      pid: 1234,
      kill: () => {
        killed += 1;
        return true;
      },
      on: () => undefined,
      stdout: { resume: () => undefined },
      stderr: { resume: () => undefined },
    } as never;
  };
  // Records when it ran, counted in spawns, so a test can tell reaping came first.
  const reap = () => void reaped.push(calls.length);
  return { spawn, reap, calls, reaped, killed: () => killed };
}

test("the Wi-Fi address wins over everything else the Mac invents", () => {
  const interfaces: Interfaces = {
    lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true } as never],
    utun4: [{ address: "100.109.226.61", family: "IPv4", internal: false } as never],
    en0: [{ address: "192.168.68.60", family: "IPv4", internal: false } as never],
    en6: [{ address: "169.254.19.156", family: "IPv4", internal: false } as never],
  };
  assert.equal(localAddress(interfaces), "192.168.68.60");
});

test("a VPN address is never the link when a real interface exists", () => {
  // utun sorts before en alphabetically, which is exactly the trap: a link to a
  // Tailscale address reaches the Mac only from inside that same tailnet.
  const interfaces: Interfaces = {
    en1: [{ address: "10.0.0.5", family: "IPv4", internal: false } as never],
    utun0: [{ address: "100.64.0.1", family: "IPv4", internal: false } as never],
  };
  assert.equal(localAddress(interfaces), "10.0.0.5");
});

test("en interfaces are ordered by number, not by string", () => {
  const interfaces: Interfaces = {
    en10: [{ address: "10.0.0.10", family: "IPv4", internal: false } as never],
    en2: [{ address: "10.0.0.2", family: "IPv4", internal: false } as never],
  };
  assert.equal(localAddress(interfaces), "10.0.0.2");
});

test("a numeric family is understood as well as the string one", () => {
  const interfaces: Interfaces = {
    en0: [{ address: "192.168.1.4", family: 4, internal: false } as never],
  };
  assert.equal(localAddress(interfaces), "192.168.1.4");
});

test("a Mac with nothing but loopback has no link to offer", () => {
  const interfaces: Interfaces = {
    lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true } as never],
  };
  assert.equal(localAddress(interfaces), "");
});

test("an interface with only a link-local lease is not a link", () => {
  const interfaces: Interfaces = {
    en6: [{ address: "169.254.1.2", family: "IPv4", internal: false } as never],
  };
  assert.equal(localAddress(interfaces), "");
});

test("starting listens, announces the service, and hands back a link", async () => {
  const fake = child();
  const waker = createWaker({
    port: PORT,
    name: "Test",
    spawn: fake.spawn,
    reap: fake.reap,
    interfaces: () => ({ en0: [{ address: "192.168.68.60", family: "IPv4", internal: false } as never] }),
  });

  assert.equal(waker.url(), "", "no link before there is anything to link to");
  await waker.start();
  assert.equal(waker.error(), "");
  assert.equal(waker.url(), `http://192.168.68.60:${PORT}`);
  assert.deepEqual(fake.calls, [["/usr/bin/dns-sd", "-R", "Test", "_caffeine-wake._tcp", "local", String(PORT)]]);

  waker.stop();
  assert.equal(fake.killed(), 1);
  assert.equal(waker.url(), "");
});

test("a port somebody else holds is reported rather than papered over", async () => {
  const squatter = createServer();
  await new Promise<void>((resolve) => squatter.listen(PORT + 1, resolve));

  const fake = child();
  const waker = createWaker({ port: PORT + 1, spawn: fake.spawn, reap: fake.reap, interfaces: () => ({}) });
  await waker.start();

  assert.match(waker.error(), /EADDRINUSE/);
  // No link either: one pointing at a stranger's service is worse than none.
  assert.equal(waker.url(), "");
  assert.deepEqual(fake.calls, [], "nothing is announced that is not listening");

  waker.stop();
  await new Promise<void>((resolve) => squatter.close(() => resolve()));
});

test("a Mac with no reachable address listens but offers no link", async () => {
  const fake = child();
  const waker = createWaker({ port: PORT + 2, spawn: fake.spawn, reap: fake.reap, interfaces: () => ({}) });
  await waker.start();
  assert.equal(waker.error(), "");
  assert.equal(waker.url(), "");
  waker.stop();
});

test("the default port is one browsers are willing to open", () => {
  // Safari and Chrome refuse a long list of ports outright — 22 and 5900 among them —
  // and the whole point of this one is that a link to it opens from a phone.
  const refused = new Set([22, 25, 110, 143, 445, 993, 995, 5060, 5061, 6000, 6665, 6666, 6667, 6668, 6669, 6697, 10080]);
  assert.equal(refused.has(WAKE_PORT), false);
  assert.ok(WAKE_PORT > 1024, "a port under 1024 would need root");
});

test("a client that hangs up mid-handshake does not take the plugin with it", async () => {
  const fake = child();
  const port = PORT + 3;
  const waker = createWaker({
    port,
    spawn: fake.spawn,
    reap: fake.reap,
    interfaces: () => ({ en0: [{ address: "192.168.68.60", family: "IPv4", internal: false } as never] }),
  });
  await waker.start();
  assert.equal(waker.error(), "");

  // A reset rather than a polite close: this is what a browser does when it gives up on
  // a port that answers nothing, and what Node reports to the server as ECONNRESET. Left
  // unhandled it is an uncaught 'error' event — which ended the real plugin the first
  // time a curl hit this port.
  await new Promise<void>((resolve) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.resetAndDestroy();
      resolve();
    });
    socket.on("error", () => resolve());
  });
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Still serving. Were the error unhandled, this test process would not be here to ask.
  await new Promise<void>((resolve, reject) => {
    const probe = connect(port, "127.0.0.1", () => {
      probe.end();
      resolve();
    });
    probe.on("error", reject);
  });

  waker.stop();
});

test("an earlier life's announcement is reaped before a new one is made", async () => {
  const fake = child();
  const waker = createWaker({ port: PORT + 4, name: "Test", spawn: fake.spawn, reap: fake.reap, interfaces: () => ({}) });
  await waker.start();

  // Order is the whole point: reaping after the spawn would match the child just
  // started and kill the announcement this plugin depends on.
  assert.deepEqual(fake.reaped, [0], "reaped once, before any dns-sd existed");
  assert.equal(fake.calls.length, 1);
  waker.stop();
});

test("the reaper's pattern is exactly what announce builds", () => {
  // These two drifting apart is the failure that leaves orphans behind while looking
  // like it works, so they are checked against each other rather than by eye.
  assert.equal(announcement("Caffeine", WAKE_PORT), `/usr/bin/dns-sd -R Caffeine _caffeine-wake._tcp local ${WAKE_PORT}`);
});

test("a browser gets the page, and gets it fresh every time", async () => {
  const fake = child();
  const port = PORT + 5;
  let renders = 0;
  const waker = createWaker({
    port,
    spawn: fake.spawn,
    reap: fake.reap,
    interfaces: () => ({}),
    render: () => `<!doctype html><title>render ${++renders}</title>`,
  });
  await waker.start();

  const first = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(first.status, 200);
  assert.match(first.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.match(await first.text(), /render 1/);

  // Rendered per request: the page describes a moment, and the next press of the link
  // is a different one.
  const second = await fetch(`http://127.0.0.1:${port}/`);
  assert.match(await second.text(), /render 2/);

  waker.stop();
});
