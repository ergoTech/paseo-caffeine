import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeeper } from "./keeper.server.ts";

/** A child that lives until killed: the shape of caffeinate without needing macOS. */
const sleeper = { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] };

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

test("hold starts a child and release stops it", async () => {
  const keeper = createKeeper(sleeper);
  assert.equal(keeper.active(), false);
  keeper.hold();
  await settle();
  assert.equal(keeper.active(), true);
  assert.equal(keeper.error(), "");
  keeper.release();
  await settle();
  assert.equal(keeper.active(), false);
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
  await settle();
  assert.equal(keeper.active(), false);
  assert.match(keeper.error(), /ENOENT|nonexistent/);
});

test("a child that exits at once is reported as an error", async () => {
  const keeper = createKeeper({ command: process.execPath, args: ["-e", "process.exit(3)"] });
  keeper.hold();
  await settle();
  assert.equal(keeper.active(), false);
  assert.match(keeper.error(), /exited with 3/);
});

test("a release clears the error", async () => {
  const keeper = createKeeper({ command: "/nonexistent/caffeinate", args: [] });
  keeper.hold();
  await settle();
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
