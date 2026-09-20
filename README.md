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
and **Sleep now**, which sends the Mac under from wherever you are. Below them is the
link that wakes it again.

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

**Keep display on** rides on its own RPC that takes a patch, rather than on the mode: it
is orthogonal to why the Mac is being held, and it survives a mode change and a spent
timer alike.

## Sleeping, and getting back

**Sleep now** runs `pmset sleepnow`, a second after answering. The delay is the whole
trick: the caller is usually a phone, the answer travels over a connection the suspend is
about to kill, and a reply that leaves first turns "did it take?" into a fact. Nothing is
written down — sleeping is an act, not a mode, so a Mac held awake for agents goes under
now and is held again when it comes back.

Waking it is the other half, and it belongs to the network rather than to this plugin.
A sleeping Mac hands its Bonjour-advertised services to a **sleep proxy** — an Apple TV
or a HomePod on the same network. The proxy answers ARP on the Mac's behalf, and when
somebody opens a connection to one of those advertised ports it sends the magic packet
that wakes it. So the plugin advertises one:

- a small web server on port **9999**, which answers the knock with one page: this Mac's
  name, the minute it woke, the battery, and which mode it came back under
- `dns-sd -R … _caffeine-wake._tcp … 9999` beside it, which is what the proxy actually
  sees — a listening socket nobody announced is invisible to that machinery

The page is a receipt, not a service. Everything in it is inline — no fonts, no scripts,
no second request — because whoever is reading it just woke a Mac from a phone that may
have no route anywhere except the VPN it came in on. `no-store`, too: it describes a
moment, and a cached copy of it is a lie the next time the link is pressed.

The link under the tiles is that port at the Mac's own address on the local network.
Copy it once into a shortcut on the phone; pressing it months later wakes the Mac from
outside the house too, as long as you are on the VPN that puts you inside it.

`dns-sd` has no `-w` to tie it to the plugin the way `caffeinate` has, and leaning on a
broken stdout pipe does not work either — it goes quiet after the registration line, so
it never writes into the pipe that would kill it. Two reloads left two live `dns-sd`s
both advertising the same port. So each start reaps the announcements of its own past
lives, matched on the exact command line `announce` builds, before making a new one.

Three things have to be true for any of this to work, and none of them are the plugin's
to arrange: **Wake for network access** on in Energy Saver, the Mac **on the charger**
(Apple ignores network wakes on battery), and a sleep proxy on the network. `pmset -g log`
settles it after the fact — a wake `due to … wifibt` came from the network, one `due to
… HID Activity` came from somebody touching the trackpad.

A header button would have been an obvious third place for all this and is not available —
`PluginHeaderButtonContribution` needs a `workspaceId`, and this surface is global.

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

**The wake port is 9999 on purpose.** Browsers refuse a long list of ports outright, 22
and 5900 among them, and the point of this one is that a link to it opens from a phone.
Anything above 1024 also keeps the socket out of root's territory.

**The anchor is not authenticated, and cannot usefully be.** By the time a connection
arrives the Mac is already awake — the proxy woke it to deliver the packet. A secret
checked after that point protects nothing, and the worst anyone within reach of the
network can do with the port is wake a Mac that was asleep.

**The timer is set in minutes, not hours.** Half an hour is the shortest useful hold and
does not fit a whole-hour union, so `setMode` takes `minutes` and the chips render
themselves through the same `formatRemaining` the countdown uses — 30 becomes "30 min",
60 becomes "1 h", with no extra strings in any locale.

**The host's `SettingsSwitch` needs a full-width row.** Given half a phone's width it
wraps the label, wraps the hint, and drops the toggle onto a line of its own — three
ragged lines where the rest of the page has tidy tiles. The display toggle is a
`ModeCard` instead, showing "on" the same way a chosen mode does: by the border, with
`MonitorOff`/`Monitor` carrying the state as well. **Sleep now** is the same tile shape
without a state to show — it borrows the selected look only while the request is in
flight, which on a phone is the last thing rendered before the connection dies. The app ships the whole lucide
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
