# Caffeine

A switch for the Mac's sleep, inside [Paseo](https://getpaseo.com): on the desktop,
on the phone, and per host when several are connected.

Agents keep working after you walk away; a MacBook on battery does not. Until now the
machine stayed awake only because Orca ran `caffeinate` underneath itself. This plugin
gives Paseo the same lever with three positions:

| | |
|---|---|
| **On** | The Mac does not sleep until you say otherwise. Survives a daemon restart. |
| **1 h / 3 h / 8 h** | The Mac does not sleep until the deadline, then the switch goes back to Off by itself. |
| **While agents work** | The Mac does not sleep while at least one Paseo agent on this host is running, and for three minutes after the last one went quiet. |

Only system sleep is held; the display sleeps as usual. A closed lid still sleeps a
MacBook, `caffeinate` or not.

## Installing it

```sh
npm install
paseo plugin install ./paseo-caffeine      # once
paseo plugin reload caffeine               # after every change
```

Then **Caffeine** in the sidebar, or ⌘K and type "caffeine".

## How it works

The server half runs `caffeinate -i -s -w <its own pid>` as a child process while the
policy says so, and re-evaluates every thirty seconds: it asks the daemon how many agents
are running, moves a busy window, and starts or stops the child. `-w` ties the child to
the plugin, so a plugin killed without cleanup takes its `caffeinate` down with it. Timer
holds add `-t` as a second guard.

The mode lives in `~/.jobby-jobs/caffeine.json` — a fixed path, because a plugin cannot
find its own directory.

Doubt resolves towards staying awake: if the daemon does not answer about agents, the
last answer stands for the same three minutes an idle answer would.

## Things that are the way they are for a reason

**Auto mode needs one request after the daemon starts.** The daemon hands its API to
RPC handlers and nowhere else, so the plugin keeps the most recent one; until a client
has called anything, agents cannot be counted and the surface says it is waiting. Every
connecting client calls `caffeine.get` once for exactly this reason. Verified on the
daemon: the object keeps answering long after the request that carried it.

**Server code starts from `contribute()` behind a guard.** `contribute()` runs in both
bundles; `process.versions.node` exists only on the daemon, so the controller starts
there and the client bundle never touches a `*.server.ts` export.

**Command Center ids start with a letter.** `3h` was refused by the app with "Invalid
Command Center item id", and one bad item takes the whole client contribution down with
it — sidebar entry included — while `paseo plugin ls` still says `running`. The message
appears only in the desktop app's own log, `~/Library/Logs/Paseo/main.log`.

**Tests run the TypeScript sources directly** under `node --test`, which is why relative
imports carry their `.ts` extension and type imports say `import type`. The bundler is
happy either way; Node is not.
