# Caffeine

A switch for the Mac's sleep, inside [Paseo](https://getpaseo.com): on the desktop,
on the phone, and per host when several are connected.

Agents keep working after you walk away; a MacBook on battery does not. Until now the
machine stayed awake only because Orca ran `caffeinate` underneath itself. This plugin
gives Paseo the same lever with three positions:

| | |
|---|---|
| **On** | The Mac does not sleep until you say otherwise. Survives a daemon restart. |
| **30 min … 12 h** | The Mac does not sleep until the deadline, then the switch goes back to Off by itself. Six lengths: 30 min, 1 h, 2 h, 3 h, 8 h, 12 h. |
| **While agents work** | The Mac does not sleep while at least one Paseo agent on this host is running, and for three minutes after the last one went quiet. |

Two more tiles sit under the modes: whether the display is held along with the system,
and whether this page keeps its entry in the sidebar. The whole page is also a settings
screen, so hiding the entry never puts it out of reach.

Only system sleep is held and the display sleeps as usual — unless **Keep the display
on** is switched on, which holds both. A closed lid still sleeps a MacBook, `caffeinate`
or not.

The surface also shows the Mac's own battery: charge, whether the charger is in, and how
long the charge has left — or how long until it is full.

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
are running, reads the battery, moves a busy window, and starts or stops the child. `-w`
ties the child to the plugin, so a plugin killed without cleanup takes its `caffeinate`
down with it. Timer holds add `-t` as a second guard, and **Keep the display on** adds
`-d`.

The two toggles — **Keep display on** and **Hide from sidebar** — share one RPC
that takes a patch, rather than living on the mode: they are orthogonal to it, and both
survive a mode change and a spent timer. Only the first reaches `caffeinate`, so hiding
the entry restarts nothing.

**The sidebar entry is withdrawn, not skipped.** `addSidebarItem` returns its own cleanup,
but `contribute()` runs once, synchronously, and cannot wait for the daemon to say whether
the entry is wanted. So the entry is always registered and then taken away a moment later
if the stored answer says to. The surface is the only part that polls, so it reports the
switch through `client/sidebar.ts` — a one-value hand-off, because a component cannot
reach the client context and `contribute()` cannot hold React state. That module also
remembers the last value, so a five-second status poll does not re-register anything.

**Hiding is not a one-way door**: `addSettingsScreen` contributes the same page a second
time, and the switch that put the entry away is on it. A header button would have been the
obvious third place and is not available — `PluginHeaderButtonContribution` needs a
`workspaceId`, and this surface is global.

The battery comes from `pmset -g batt`, parsed rather than computed — `0:00 remaining`
next to `charged` means "not applicable", and `(no estimate)` means pmset is still
working it out. Both read as no estimate rather than as no time left. A machine without
a battery simply has no card.

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

**The entry point is split, not guarded.** `index.server.ts` loads only on the daemon
and `index.client.tsx` loads only in the app; `server/`, `client/` and `shared/` are
compiler boundaries, so the controller starts unconditionally in `index.server.ts` with
no runtime check for where it is running.

**The timer is set in minutes, not hours.** Half an hour is the shortest useful hold and
does not fit a whole-hour union, so `setMode` takes `minutes` and the chips render
themselves through the same `formatRemaining` the countdown uses — 30 becomes "30 min",
60 becomes "1 h", with no extra strings in any locale.

**The host's `SettingsSwitch` needs a full-width row.** Given half a phone's width it
wraps the label, wraps the hint, and drops the toggle onto a line of its own — three
ragged lines where the rest of the page has tidy tiles. Both toggles are `ModeCard`s
instead, showing "on" the same way a chosen mode does: by the border. The icon carries
the state too, `MonitorOff`/`Monitor` and `Eye`/`EyeOff`. The app ships the whole lucide
set, which is worth checking in
`Contents/Resources/app-dist/_expo/static/js/web/index-*.js` rather than guessing — the
names appear there as `Object.defineProperty(x,"Coffee",…)`.

**A tile's title needs `flex: 1`.** Without it a title wider than the tile runs over the
border instead of wrapping inside it, which only shows up once a title gets long.

**RPC method names are lower case.** The SDK matches them against
`/^[a-z][a-z0-9._-]*$/` and throws `Invalid plugin RPC method` on a capital, at import
time, which takes the whole plugin with it. `caffeine.setDisplay` was refused;
`caffeine.set-display` is the same idea spelled the way the SDK wants.

**Command Center ids start with a letter.** `3h` was refused by the app with "Invalid
Command Center item id", and one bad item takes the whole client contribution down with
it — sidebar entry included — while `paseo plugin ls` still says `running`. The message
appears only in the desktop app's own log, `~/Library/Logs/Paseo/main.log`.

**Tests run the TypeScript sources directly** under `node --test`, which is why relative
imports carry their `.ts` extension and type imports say `import type`. The bundler is
happy either way; Node is not.

**A controller started in a test has to be stopped in it.** `start()` opens an interval,
and `node --test` waits on the handle: one forgotten `stop()` turns a 100 ms file into a
run that only ends when the timeout does.
