# Pirates: Naval Combat

A top-down naval combat game for the browser, inspired by the ship battles in
[Sid Meier's Pirates!](https://sidmeierspirates.fandom.com/wiki/Naval_Combat).
Built with HTML5 Canvas and TypeScript — no game framework, no backend, the
whole game runs in the front end.

**This fork adds online multiplayer**: up to 4 players battle in a shared
free-for-all arena dotted with islands to hide behind. No server of your own
needed — peers connect directly over WebRTC ([PeerJS](https://peerjs.com/)),
so it still deploys as plain static files.

## Multiplayer

Pick **Multiplayer** on the menu, enter a captain name, and either **Create
Room** (you get a 5-letter room code) or **Join** with a friend's code. In the
lobby every captain chooses their own boat and readies up; the host starts the
battle once 2–4 players are in.

- **Free-for-all** — last ship afloat rules the seas. Sink or be sunk.
- **Islands & shallows** — cannonballs splash harmlessly into the sand, so use
  islands as cover. But mind your helm: **running aground is fatal** — steer
  into an island and your ship goes down with all hands.
- **Shared world** — everyone plays in the same fixed 1600×1000 arena,
  letterboxed to fit each screen. Wind affects all captains equally.
- **Host-authoritative netcode** — the room creator simulates the battle and
  broadcasts 30 Hz snapshots; guests send steering/fire inputs and render with
  smoothing. Rooms are matched through the free public PeerJS broker, then all
  game traffic flows peer-to-peer.
- **Bots** — no friends online? The host can fill empty slots with AI captains
  (**Add Bot 🤖** in the lobby, up to 3). Bots hunt the most promising target
  (close and already damaged), lead their shots with the wind, hold fire when
  an island blocks the shot, and when wounded they break off and run for
  cover, favoring fast points of sail and keeping islands between themselves
  and the threat.
- The round ends when one ship is left afloat — or when **every human captain
  is dead** (you never spectate bots finishing each other off; the healthiest
  survivor takes the win).
- After a battle the host can call a **rematch** (fresh islands) or send
  everyone **back to the lobby**. If a captain drops mid-fight, their ship
  strikes its colors and sinks.

## How to play

| Key | Action |
| --- | --- |
| `1` / `2` / `3` | Choose your ship (small / medium / large) |
| `1`–`3`, or `4` for random | Choose the enemy's ship |
| `1` / `2` / `3` | Choose difficulty (easy / medium / hard) |
| `←` / `→` or `A` / `D` | Steer left / right |
| `Space` | Fire a broadside |
| `R` | After a battle ends, return to ship select |

Your ship is always under sail and moves forward on its own — you only steer,
just like in the original Pirates!. Cannons fire a broadside from whichever
side of your hull faces the enemy, and the balls fly **perpendicular to your
heading**, so you have to maneuver to bring your guns to bear. The enemy
captain does the same: it chases you from a distance, then turns sideways to
line up its own broadside.

The wind matters too. The arrow in the top-left shows the wind direction, and
your speed depends on your angle to it: sailing perpendicular to the wind
(beam reach) is full speed, running straight downwind is a bit slower (85%),
and beating straight into the wind cuts you to 40%. The "Sails %" readout
under the arrow shows your current efficiency. The wind slowly shifts during
a battle, the background waves drift with it, and it affects both captains
equally.

## Ship types

| Type | Speed | Turning | Guns per broadside | Hits to sink |
| --- | --- | --- | --- | --- |
| Small | fast (110 px/s) | tight | 2 | 3 |
| Medium | steady (80 px/s) | moderate | 3 | 5 |
| Large | slow (55 px/s) | sluggish | 4 | 8 |

Small ships dodge and harass; large ships are slow-turning fortresses that can
delete a small ship with one well-placed volley. The enemy's ship type is
chosen at random each battle. All type stats live in one table
(`SHIP_TYPES` in `src/ship.ts`), so tuning balance is a one-line change.

## Difficulty levels

Difficulty changes the enemy captain's skill, never the damage numbers — every
cannonball still deals 1 damage.

| Level | Enemy reload | Aiming | Sailing |
| --- | --- | --- | --- |
| Easy | 2.2 s | fires at where you are | ignores the wind |
| Medium | 1.8 s | leads your movement (fires at where you'll be) | ignores the wind |
| Hard | 1.4 s (parity with you) | leads your movement | avoids chasing dead upwind |

## Combat details

- Each cannonball is tracked individually: every ball that connects removes
  exactly 1 health and triggers an explosion at the impact point, so partial
  broadside hits deal partial damage.
- Cannonballs have a maximum range (~320 px) and splash harmlessly past it.
- Hit detection tests each ball against the target ship's rotated bounding box.
- The player reloads faster than the enemy (1.4 s vs 2.2 s) to offset the AI's
  perfect aim — it computes the exact firing angle every frame.
- Health bars for both ships sit in the top-right corner, sized to each ship's
  max health.
- A sunk ship fades beneath the waves, then a victory/defeat banner appears.

## Tech stack

- **HTML5 Canvas 2D + TypeScript, no framework.** At this scope (two ships and
  a handful of cannonballs) a game framework or WebGL renderer adds more
  weight than value; plain Canvas easily holds 60 fps and keeps every line of
  game logic understandable.
- **Vite** for the dev server and build. The build output in `dist/` is just
  static HTML, CSS, and JS (~9 KB of game code) that any static host can serve.

## Project structure

```
src/main.ts        entry point: canvas setup, menu/lobby UI wiring
src/game.ts        single-player game loop, firing, collisions, HUD
src/multiplayer.ts online session: lobby, host simulation, guest rendering
src/net.ts         PeerJS transport + wire message types
src/bot.ts         AI captains for multiplayer (host-side)
src/island.ts      island generation, drawing, ship/cannonball collision
src/ship.ts        Ship class + SHIP_TYPES stat table
src/ai.ts          enemy steering and fire decisions (single player)
src/cannonball.ts  projectile movement and rendering
src/explosion.ts   impact explosion effect
src/wind.ts        wind direction drift + point-of-sail speed curve
src/input.ts       keyboard state tracking
```

## Development

```bash
npm install
npm run dev      # dev server with hot reload at http://localhost:5173
npm run build    # type-check and build static files into dist/
```

## Deployment

The repo deploys to GitHub Pages automatically: on every push to `main`, the
workflow in `.github/workflows/deploy.yml` builds the game and publishes
`dist/`. One-time setup in the repo settings: **Settings → Pages → Source →
GitHub Actions**. Vite is configured with a relative `base` (`vite.config.ts`)
so the build works under the `https://<user>.github.io/<repo>/` subpath.

## Roadmap ideas

- More cannon ammo types (chain shot, grape shot)
- Boarding when ships collide
- Sound effects
