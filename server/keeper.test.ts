import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeeper } from "./keeper.server.ts";

/** A child that lives until killed: the shape of caffeinate without needing macOS. */
const sleeper = { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] };

/**
 * Wait for a condition instead of a fixed pause: under a parallel test run a fresh
 * node child can take longer than any guess to start or to exit.
 */
async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

test("hold starts a child and release stops it", async () => {
  const keeper = createKeeper(sleeper);
  assert.equal(keeper.active(), false);
  keeper.hold();
  await waitFor(() => keeper.active());
  assert.equal(keeper.error(), "");
  keeper.release();
  await waitFor(() => !keeper.active());
});

test("holding twice keeps the same child", async () => {
  const keeper = createKeeper(sleeper);
  keeper.hold();
  await settle();
  const first = keeper.pid();
  keeper.hold();
  await settle();
  assert.equal(keeper.pid(), first);
  keeper.release();
  await settle();
});

test("a command that is missing is reported, not thrown", async () => {
  const keeper = createKeeper({ command: "/nonexistent/caffeinate", args: [] });
  keeper.hold();
  await waitFor(() => keeper.error() !== "");
  assert.equal(keeper.active(), false);
  assert.match(keeper.error(), /ENOENT|nonexistent/);
});

test("a child that exits at once is reported as an error", async () => {
  const keeper = createKeeper({ command: process.execPath, args: ["-e", "process.exit(3)"] });
  keeper.hold();
  await waitFor(() => keeper.error() !== "");
  assert.equal(keeper.active(), false);
  assert.match(keeper.error(), /exited with 3/);
});

test("a release clears the error", async () => {
  const keeper = createKeeper({ command: "/nonexistent/caffeinate", args: [] });
  keeper.hold();
  await waitFor(() => keeper.error() !== "");
  keeper.release();
  assert.equal(keeper.error(), "");
});

test("timer holds pass the remaining seconds to the command", async () => {
  const seen: string[][] = [];
  const keeper = createKeeper({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    now: () => 1_000_000,
    spawn: (command, args) => {
      seen.push([command, ...args]);
      return { pid: 42, kill: () => true, on: () => undefined } as never;
    },
  });
  keeper.hold(1_000_000 + 90_500);
  assert.deepEqual(seen[0]?.slice(-2), ["-t", "91"]);
});

/** The real argument list, without letting a real caffeinate anywhere near the test. */
function recordedArgs(hold: (keeper: ReturnType<typeof createKeeper>) => void): string[] {
  const seen: string[][] = [];
  const keeper = createKeeper({
    command: "/usr/bin/caffeinate",
    now: () => 1_000_000,
    spawn: (command, args) => {
      seen.push([command, ...args]);
      return { pid: 42, kill: () => true, on: () => undefined } as never;
    },
  });
  hold(keeper);
  return seen[0] ?? [];
}

test("the display is left to sleep unless asked for", () => {
  const args = recordedArgs((keeper) => keeper.hold());
  assert.deepEqual(args.slice(1, 3), ["-i", "-s"]);
  assert.equal(args.includes("-d"), false);
});

test("keeping the display adds -d", () => {
  const args = recordedArgs((keeper) => keeper.hold(undefined, true));
  assert.equal(args.includes("-d"), true);
  assert.equal(args.includes("-i"), true);
});

test("a timer and the display can be held together", () => {
  const args = recordedArgs((keeper) => keeper.hold(1_000_000 + 60_000, true));
  assert.equal(args.includes("-d"), true);
  assert.deepEqual(args.slice(-2), ["-t", "60"]);
});
