// Online multiplayer session: up to 4 ships in a free-for-all arena with
// islands for cover. Host-authoritative — the host runs the whole simulation
// and broadcasts snapshots; guests send steering/fire inputs and render the
// latest state with smoothing.
//
// Unlike single player (where the world IS the canvas), multiplayer uses a
// fixed logical world so every peer sees identical geometry regardless of
// their window size; each client letterboxes it to fit — or, on small (phone)
// screens, zooms in with a camera that follows your ship.

import { angleDiff } from './ai';
import { decideBot } from './bot';
import { Cannonball, drawCannonball } from './cannonball';
import { Explosion } from './explosion';
import type { Input } from './input';
import {
  drawIsland,
  generateIslands,
  islandHitsPoint,
  shipHitsIsland,
  type IslandData,
} from './island';
import {
  createGuestPeer,
  createHostPeer,
  type BallState,
  type C2HMsg,
  type GameEvent,
  type H2CMsg,
  type LobbyPlayerInfo,
  type MpMode,
  type PeerHandle,
  type PickupType,
  type ShipSpawn,
  type ShipState,
} from './net';
import { DIVE, gunOffsets, muzzleReach, RAM, SAIL_TYPES, Ship, SHIP_TYPES, wrapDelta, YOU_COLOR, type ShipTypeName, type Turn } from './ship';
import { drawTouchBtn, hitBtn, layoutTouchButtons, touchCapable } from './touchui';
import { Wind } from './wind';
import type { DataConnection } from 'peerjs';

export const WORLD_W = 1600;
export const WORLD_H = 1000;

export const MAX_PLAYERS = 21; // one human host + up to 20 bots (or more humans)
const MAX_DT = 0.05;
const RELOAD = 1.4; // s between broadsides, same for everyone

// ── Power-ups ─────────────────────────────────────────────────────────────────
const MG_RELOAD = 0.16; // machine-gun cadence
const MG_DURATION = 5; // s of continuous fire
const DOUBLE_DURATION = 10; // s of firing both sides at once (barrels show on both)
const SPEED_DURATION = 8; // s of double speed
const SPEED_MULT = 2;
const SHIELD_HITS = 5; // incoming hits absorbed

// Win score weights: sinking an enemy matters most, damage next, survival least.
const SCORE_TIME = 0.1; // per second alive
const SCORE_DAMAGE = 1; // per point of hull damage dealt
const SCORE_KILL = 8; // per enemy sunk

// Submarine diving: hold ↓/S. While submerged you're invisible & untouchable,
// but you can't fire or grab pickups — and the charge meter limits your time
// under. Tuning is shared with practice mode via DIVE in ship.ts.
const DIVE_MAX = DIVE.max;
const DIVE_REFILL = DIVE.refill;
const DIVE_ANIM = DIVE.anim;
const SUB_IMMUNE = DIVE.immune;
const SUB_HIDDEN = DIVE.hidden;
const MG_RELOAD_SUB = 0.35; // rapid-fire cadence for torpedoes

// Ramming rules are shared with practice mode via RAM in ship.ts.
const RAM_DMG = RAM.dmg;
const RAM_SELF_DMG = RAM.selfDmg;
const RAM_BOW_COS = RAM.bowCos;
const RAM_CD = RAM.cd;
const MAX_PICKUPS = 9;
const MAX_PICKUPS_SCORE = 15; // Leaderboard is a bounty-rich brawl — more on the water at once
const PICKUP_HASTE_SCORE = 0.55; // ...and they respawn faster too (interval multiplier)
const PICKUP_R = 15; // px
const PICKUP_TTL = 20; // s before an uncollected pickup relocates
const SPAWN_PROTECT = 2; // s of spawn invulnerability while ships scatter
const START_FREEZE = 3; // s everyone holds still at round start to find their ship

// Leaderboard is a fixed-length deathmatch: sink as many as you can before the
// clock runs out, respawning each time you go down. (Survivor is untimed —
// last ship afloat wins — so none of this applies there.)
const MATCH_DURATION = 90; // s of play in a Leaderboard match (1:30)
const DEATH_PAUSE = 2; // s a sunk ship stays down before it respawns
const RESPAWN_FREEZE = 1.2; // s a respawned ship holds still before it can move/fire
const RESPAWN_BAND = 0.25; // respawn within the central 50% of the map (0.25–0.75 each axis)
// The storm holds off until the final stretch, then ramps to full by time-up —
// and respawns stop the moment it sets in, so the last 20 s are sudden death.
const STORM_WINDOW = 20; // s of maelstrom finale at the end of a Leaderboard match

// Whirlpool (maelstrom): a growing vortex at the arena center that drags every
// ship inward and shreds anyone caught outside its shrinking eye. Radial, so it
// works with the wrap-around world (there's no "safe far edge" — the current
// tows you back to the middle wherever you are).
const WHIRL_START = 15; // s of calm before the maelstrom forms
const WHIRL_RAMP = 55; // s to reach full strength
const EYE_MAX = 720; // eye radius before the whirlpool forms (covers most of the arena)
const EYE_MIN = 150; // fully-formed eye radius
// Pull > the fastest hull (165 px/s) at full strength, so even a ship sailing
// straight out gets dragged inward — the current alone converges the fight.
const PULL_MAX = 188; // px/s inward current at full strength (outside the eye)
const SWIRL_FRAC = 0.5; // tangential swirl as a fraction of the inward pull

// Spawn cadence per type (min, max seconds). Health is common; the rest rarer.
const PICKUP_SPAWN: Record<PickupType, [number, number]> = {
  health: [6, 10],
  shield: [15, 24],
  speed: [13, 21],
  double: [17, 27],
  machinegun: [22, 34],
};
const PICKUP_ORDER = Object.keys(PICKUP_SPAWN) as PickupType[];

const PICKUP_META: Record<PickupType, { icon: string; color: string; label: string }> = {
  health: { icon: '➕', color: '#e8503a', label: '+1 HEALTH' },
  shield: { icon: '⛨', color: '#3aa0e8', label: 'SHIELD ×5' },
  speed: { icon: '⚡', color: '#e8c53a', label: '2× SPEED' },
  double: { icon: '⇄', color: '#7bd15f', label: 'DBL BROADSIDE' },
  machinegun: { icon: '⁘', color: '#e8892a', label: 'RAPID FIRE' },
};
const ZERO_TIMERS: Record<PickupType, number> = {
  health: 0,
  shield: 0,
  speed: 0,
  double: 0,
  machinegun: 0,
};
// Camera: on roomy screens the whole arena is letterboxed to fit, as before.
// Below this fit scale (phones, tiny windows) ships turn thumbnail-sized, so
// the camera zooms to at least FOLLOW_SCALE and tracks your ship instead —
// the world wraps, so the view pans seamlessly with no edges to clamp against.
const FOLLOW_BELOW = 0.5;
// 0.6 ≈ 1.8× the visible area of the original 0.8 — playtesters wanted more
// warning of who's approaching; below ~0.55 ships get hard to tap-read.
const FOLLOW_SCALE = 0.6;

const SNAPSHOT_INTERVAL = 1 / 30;
const INPUT_INTERVAL = 0.05; // guest input heartbeat
const END_DELAY = 1.7; // let the sinking animation play before declaring a winner
const WAVE_DRIFT = 14;
const SMOOTH_RATE = 14; // guest position smoothing (higher = snappier)
const SNAP_DIST = 250; // beyond this a target jump is a wrap/teleport — snap, don't glide

// Humans sail vivid hulls, bots sail greys — so the real players pop out of a
// crowded bot fleet at a glance. (Your own hull is repainted pink locally, so
// hot pink stays out of this palette.)
export const HUMAN_COLORS = [
  '#ffd23f', // yellow
  '#3fa7ff', // blue
  '#ff7a2e', // orange
  '#8be04a', // lime
  '#c77dff', // violet
  '#ff5d5d', // coral
  '#2ee6c8', // aqua
];

export const BOT_COLORS = [
  '#8d939b',
  '#6f757d',
  '#a7adb4',
  '#5a6068',
  '#98a0a8',
  '#7b828a',
];

/** Hull/lobby color for crew slot `i`: humans cycle the vivid palette, bots the
 *  greys. Counted per kind, so the 1st human is always yellow no matter how
 *  many bots sit ahead of them in the roster. */
export function crewColor(i: number, crew: Array<{ bot: boolean }>): string {
  const me = crew[i];
  if (!me) return '#fff';
  let n = 0;
  for (let k = 0; k < i; k++) if (crew[k].bot === me.bot) n++;
  const palette = me.bot ? BOT_COLORS : HUMAN_COLORS;
  return palette[n % palette.length];
}

const BOT_NAMES = [
  'Iron Bess',
  'Mad Morgan',
  'Salty Pete',
  'One-Eye Jack',
  'Blackfin Sal',
  'Cutlass Kate',
  'Barnacle Bill',
  'Gunner Gwen',
  'Rusty Rourke',
  'Scurvy Sam',
  'Tessa Tide',
  'Dread Ned',
  'Foggy Meg',
  'Hook-Hand Hal',
  'Stormy Sue',
  'Powder Pip',
  'Keelhaul Kit',
  'Marooned Moe',
  'Siren Sadie',
  'Cannonball Cass',
];

// Spawn points evenly spaced on a ring so a crowded free-for-all starts fair,
// every ship facing the melee at the center.
const SPAWNS: Array<{ x: number; y: number }> = Array.from({ length: MAX_PLAYERS }, (_, i) => {
  const a = -Math.PI / 2 + (i / MAX_PLAYERS) * Math.PI * 2;
  return {
    x: WORLD_W / 2 + Math.cos(a) * WORLD_W * 0.4,
    y: WORLD_H / 2 + Math.sin(a) * WORLD_H * 0.4,
  };
});

interface Wave {
  x: number;
  y: number;
  r: number;
}

interface Pickup {
  id: number;
  type: PickupType;
  x: number;
  y: number;
  ttl: number;
}

/** Host-side timers for a ship's active power-ups (in battle-clock seconds). */
interface Buff {
  doubleUntil: number;
  speedUntil: number;
  mgUntil: number;
  mgArmed: boolean; // machine gun picked up, waiting for the next trigger shot
}

/** What guests need to render a ship's power-up state. */
interface BuffView {
  shield: number;
  spd: boolean;
  dbl: boolean;
  mg: boolean;
  inv: boolean; // spawn protection
}

/** Host-side score accumulators for a ship. */
interface Score {
  time: number; // seconds survived
  damage: number; // hull damage dealt to enemies
  kills: number; // enemies sunk
}

export interface LeaderboardEntry {
  idx: number; // ship index
  name: string;
  color: string;
  score: number;
  kills: number;
  alive: boolean;
  you: boolean;
}

/** White foam ring where a cannonball hits sand or surf. */
class Splash {
  x: number;
  y: number;
  private age = 0;

  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }

  get done(): boolean {
    return this.age >= 0.45;
  }

  update(dt: number) {
    this.age += dt;
  }

  draw(ctx: CanvasRenderingContext2D) {
    const t = Math.min(this.age / 0.45, 1);
    ctx.save();
    ctx.globalAlpha = 1 - t;
    ctx.strokeStyle = '#eaf6ff';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(this.x, this.y, 3 + 12 * t, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

interface HostPlayer {
  conn: DataConnection | null; // null for the host itself and for bots
  name: string;
  ship: ShipTypeName;
  ready: boolean;
  connected: boolean;
  bot: boolean;
  turn: Turn;
  fire: boolean;
  dive: boolean;
}

export interface MpCallbacks {
  /** In the lobby now. Host: code is '' until the broker responds. Guest: real code. */
  onRoomReady(code: string): void;
  /** Host only: the shareable code arrived (string), or the broker was
   *  unreachable so this is an offline, bots-only room (null). */
  onRoomCode(code: string | null): void;
  onLobby(players: LobbyPlayerInfo[], you: number, canStart: boolean, mode: MpMode): void;
  onStart(): void;
  /** winnerName null = mutual destruction. */
  onEnd(winnerName: string | null): void;
  onToLobby(): void;
  /** Fatal — the session is dead (host gone, room not found, …). */
  onError(message: string): void;
}

interface Sounds {
  fire: () => void; // you fired
  myHit: () => void; // your shot/ram landed on someone
  getHit: () => void; // you took a hit
}

export class MpSession {
  readonly isHost: boolean;

  private ctx: CanvasRenderingContext2D;
  private input: Input;
  private cb: MpCallbacks;
  private sounds: Sounds;
  private handle: PeerHandle | null = null;
  private active = true;
  private phase: 'connecting' | 'lobby' | 'battle' | 'end' = 'connecting';

  // Host state
  private players: HostPlayer[] = [];
  private balls: Cannonball[] = [];
  private pendingEvents: GameEvent[] = [];
  private endTimer = -1;
  private snapshotAcc = 0;

  // Guest state
  private conn: DataConnection | null = null;
  private targets: ShipState[] = [];
  private ballStates: BallState[] = [];
  private lastSnapAt = 0;
  private inputAcc = 0;
  private lastSent = { turn: 0 as Turn, fire: false, dive: false };

  // Shared battle state (host simulates; guest mirrors)
  private you = 0;
  private islands: IslandData[] = [];
  private spawns: ShipSpawn[] = [];
  private ships: Ship[] = [];
  private clock = 0; // seconds since the round began (drives buff timers)
  private pickups: Pickup[] = [];
  private pickupId = 0;
  private pickupTimers: Record<PickupType, number> = { ...ZERO_TIMERS };
  private buffs: Buff[] = []; // host-authoritative
  private buffView: BuffView[] = []; // render state (host + guest)
  private scores: Score[] = []; // host-authoritative
  private scoreView: { score: number; kills: number }[] = []; // host + guest (leaderboard)
  private ramCd: number[] = []; // per-ship ram-damage cooldown (host)
  private spawnUntil: number[] = []; // per-ship spawn-invulnerability expiry (host)
  private respawnAt: number[] = []; // clock time a sunk ship respawns (Leaderboard); Infinity = n/a
  private moveFreezeUntil: number[] = []; // clock until a (re)spawned ship may move/fire (host)
  private timeLeft = -1; // Leaderboard match seconds remaining (host computes, guest mirrors); -1 = untimed
  private diveCharge: number[] = []; // per-ship submarine dive charge (host)
  private guestCharge: number[] = []; // dive charge fractions mirrored from snapshots (guest)
  private eyeR = EYE_MAX; // whirlpool eye radius (host computes, guest mirrors)
  private freeze = 0; // start-of-round locate-your-ship pause (host computes, guest mirrors)
  private mode: MpMode = 'score'; // win condition (host picks in the lobby, guest mirrors)
  private wind = new Wind();
  private explosions: Explosion[] = [];
  private splashes: Splash[] = [];
  private waves: Wave[] = [];
  private looping = false;
  private lastTime = 0;
  // Not readonly: some WebViews under-report touch capability, so the first
  // real touch event anywhere upgrades this at runtime.
  private isTouchDevice = touchCapable();

  private constructor(
    isHost: boolean,
    ctx: CanvasRenderingContext2D,
    input: Input,
    cb: MpCallbacks,
    sounds: Sounds,
  ) {
    this.isHost = isHost;
    this.ctx = ctx;
    this.input = input;
    this.cb = cb;
    this.sounds = sounds;
    // Dev-only hook so E2E tests can observe the simulation; stripped in prod.
    if (import.meta.env.DEV) (window as unknown as { __mp: MpSession }).__mp = this;
    for (let i = 0; i < 40; i++) {
      this.waves.push({
        x: Math.random() * WORLD_W,
        y: Math.random() * WORLD_H,
        r: 6 + Math.random() * 10,
      });
    }
    // Registered regardless of detection: if a touch ever arrives, controls
    // must work — detection only decides whether buttons show before then.
    const c = ctx.canvas;
    c.addEventListener('touchstart', this.onTouch, { passive: true });
    c.addEventListener('touchmove', this.onTouch, { passive: true });
    c.addEventListener('touchend', this.onTouch, { passive: true });
    c.addEventListener('touchcancel', this.onTouch, { passive: true });
    // Any touch (e.g. tapping through the lobby) proves the device is touch,
    // so the buttons are already visible when the battle starts.
    window.addEventListener('touchstart', this.sawTouch, { passive: true, once: true });
  }

  private sawTouch = () => {
    this.isTouchDevice = true;
  };

  /** On-screen thumb controls — multiplayer battles are steerable on touch
   *  devices just like practice mode (plus a dive button for submarines). */
  private onTouch = (e: TouchEvent) => {
    this.isTouchDevice = true;
    if (this.phase !== 'battle') return;
    const rect = this.ctx.canvas.getBoundingClientRect();
    const scaleX = this.viewW / rect.width;
    const scaleY = this.viewH / rect.height;
    const btns = layoutTouchButtons(this.viewW, this.viewH);
    let left = false;
    let right = false;
    let fire = false;
    let dive = false;
    for (const t of Array.from(e.touches)) {
      const tx = (t.clientX - rect.left) * scaleX;
      const ty = (t.clientY - rect.top) * scaleY;
      if (hitBtn(btns.left, tx, ty)) left = true;
      if (hitBtn(btns.right, tx, ty)) right = true;
      if (hitBtn(btns.fire, tx, ty)) fire = true;
      if (hitBtn(btns.dive, tx, ty)) dive = true;
    }
    const sub = this.ships[this.you]?.type === 'submarine';
    this.input.setVirtual(left, right, fire, dive && sub);
  };

  // ── Session entry points ────────────────────────────────────────────────────

  static host(
    name: string,
    ctx: CanvasRenderingContext2D,
    input: Input,
    cb: MpCallbacks,
    sounds: Sounds,
  ): MpSession {
    const s = new MpSession(true, ctx, input, cb, sounds);
    s.players = [
      { conn: null, name: cleanName(name), ship: 'small', ready: false, connected: true, bot: false, turn: 0, fire: false, dive: false },
    ];
    // Open the lobby immediately so bot play never waits on (or requires) the
    // matchmaking broker; the room code fills in when/if the broker responds.
    // Deferred a microtask so the caller's `mp = MpSession.host(...)` binding
    // is in place before the UI callbacks (which read it) run.
    s.phase = 'lobby';
    queueMicrotask(() => {
      if (!s.active) return;
      cb.onRoomReady('');
      s.pushLobby();
    });
    s.handle = createHostPeer({
      onReady: (code) => cb.onRoomCode(code),
      onConnection: (conn) => s.acceptConnection(conn),
      onError: (msg, recoverable) => {
        if (recoverable) cb.onRoomCode(null); // offline: keep playing vs bots
        else s.fail(msg);
      },
    });
    return s;
  }

  static join(
    code: string,
    name: string,
    ctx: CanvasRenderingContext2D,
    input: Input,
    cb: MpCallbacks,
    sounds: Sounds,
  ): MpSession {
    const s = new MpSession(false, ctx, input, cb, sounds);
    s.handle = createGuestPeer(code, {
      onOpen: (conn) => {
        s.conn = conn;
        conn.on('data', (data) => s.onHostMessage(data as H2CMsg, code));
        conn.on('close', () => s.fail('Connection to the host was lost.'));
        conn.send({ t: 'hello', name: cleanName(name) } satisfies C2HMsg);
      },
      onError: (msg) => s.fail(msg),
    });
    return s;
  }

  // ── Public controls (called from the UI) ────────────────────────────────────

  setShip(type: ShipTypeName) {
    if (this.isHost) {
      this.players[0].ship = type;
      this.pushLobby();
    } else {
      this.conn?.send({ t: 'choose', ship: type } satisfies C2HMsg);
    }
  }

  setReady(ready: boolean) {
    if (this.isHost) {
      this.players[0].ready = ready;
      this.pushLobby();
    } else {
      this.conn?.send({ t: 'ready', ready } satisfies C2HMsg);
    }
  }

  private makeBot(): HostPlayer | null {
    if (this.players.length >= MAX_PLAYERS) return null;
    const used = new Set(this.players.map((p) => p.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) ?? `Bot ${this.players.length}`;
    return {
      conn: null,
      name,
      ship: SAIL_TYPES[Math.floor(Math.random() * SAIL_TYPES.length)],
      ready: true,
      connected: true,
      bot: true,
      turn: 0,
      fire: false,
      dive: false,
    };
  }

  /** Host only: fill one empty slot with an AI captain (always ready). */
  addBot() {
    if (!this.isHost || this.phase !== 'lobby') return;
    const bot = this.makeBot();
    if (!bot) return;
    this.players.push(bot);
    this.pushLobby();
  }

  /** Host only: add up to `count` AI captains (bounded by room capacity). */
  fillBots(count = MAX_PLAYERS) {
    if (!this.isHost || this.phase !== 'lobby') return;
    for (let n = 0; n < count; n++) {
      const bot = this.makeBot();
      if (!bot) break;
      this.players.push(bot);
    }
    this.pushLobby();
  }

  /** Host only: dismiss a bot from the lobby. */
  removeBot(index: number) {
    if (!this.isHost || this.phase !== 'lobby' || !this.players[index]?.bot) return;
    this.players.splice(index, 1);
    this.pushLobby();
  }

  /** Host only: choose the win condition (Leaderboard score vs Survivor). */
  setMode(mode: MpMode) {
    if (!this.isHost || this.phase !== 'lobby') return;
    this.mode = mode;
    this.pushLobby();
  }

  /** The current win condition (for UI copy). */
  get gameMode(): MpMode {
    return this.mode;
  }

  /** Host only: launch the battle (needs 2+ players; ready is not required). */
  startBattle() {
    if (!this.isHost || this.phase !== 'lobby' || !this.canStart()) return;
    this.beginRound();
  }

  /** Host only: same crew, fresh islands and spawns. */
  rematch() {
    if (!this.isHost || this.phase !== 'end') return;
    this.players = this.players.filter((p) => p.connected);
    this.beginRound();
  }

  /** Host only: everyone back to the lobby. */
  backToLobby() {
    if (!this.isHost || this.phase !== 'end') return;
    this.players = this.players.filter((p) => p.connected);
    for (const p of this.players) p.ready = p.bot;
    this.phase = 'lobby';
    this.stopLoop();
    this.broadcast({ t: 'toLobby' });
    this.cb.onToLobby();
    this.pushLobby();
  }

  leave() {
    this.active = false;
    this.stopLoop();
    this.handle?.destroy();
    this.handle = null;
    const c = this.ctx.canvas;
    c.removeEventListener('touchstart', this.onTouch);
    c.removeEventListener('touchmove', this.onTouch);
    c.removeEventListener('touchend', this.onTouch);
    c.removeEventListener('touchcancel', this.onTouch);
    window.removeEventListener('touchstart', this.sawTouch);
    this.input.setVirtual(false, false, false, false);
  }

  // ── Host: lobby & connections ───────────────────────────────────────────────

  private acceptConnection(conn: DataConnection) {
    // Lobby joins AND mid-battle late joins are welcome; only a full roster or
    // the end-of-round result screen turns a captain away.
    if (!this.joinable()) {
      const reason =
        this.players.length >= MAX_PLAYERS
          ? 'Room is full.'
          : 'The battle just ended — ask the host to rematch, then join again.';
      conn.on('open', () => {
        conn.send({ t: 'reject', reason } satisfies H2CMsg);
        setTimeout(() => conn.close(), 200);
      });
      return;
    }

    conn.on('data', (data) => this.onGuestMessage(conn, data as C2HMsg));
    conn.on('close', () => this.onGuestGone(conn));
  }

  private joinable(): boolean {
    return (
      (this.phase === 'lobby' || this.phase === 'battle') && this.players.length < MAX_PLAYERS
    );
  }

  private onGuestMessage(conn: DataConnection, msg: C2HMsg) {
    if (!this.active || !msg || typeof msg !== 'object') return;
    const idx = this.players.findIndex((p) => p.conn === conn);

    if (msg.t === 'hello') {
      if (idx !== -1) return; // already joined
      if (!this.joinable()) {
        conn.send({ t: 'reject', reason: 'Room is full.' } satisfies H2CMsg);
        setTimeout(() => conn.close(), 200);
        return;
      }
      if (this.phase === 'battle') {
        this.lateJoin(conn, msg.name);
        return;
      }
      this.players.push({
        conn,
        name: this.uniqueName(msg.name),
        ship: 'small',
        ready: false,
        connected: true,
        bot: false,
        turn: 0,
        fire: false,
        dive: false,
      });
      this.pushLobby();
      return;
    }

    if (idx === -1) return;
    const player = this.players[idx];

    if (msg.t === 'choose' && msg.ship in SHIP_TYPES) {
      player.ship = msg.ship;
      this.pushLobby();
    } else if (msg.t === 'ready') {
      player.ready = !!msg.ready;
      this.pushLobby();
    } else if (msg.t === 'input') {
      player.turn = msg.turn === -1 || msg.turn === 1 ? msg.turn : 0;
      player.fire = !!msg.fire;
      player.dive = !!msg.dive;
    }
  }

  private onGuestGone(conn: DataConnection) {
    if (!this.active) return;
    const idx = this.players.findIndex((p) => p.conn === conn);
    if (idx === -1) return;

    if (this.phase === 'lobby') {
      this.players.splice(idx, 1);
      this.pushLobby();
    } else {
      // Mid-battle: their ship strikes its colors and goes down.
      this.players[idx].connected = false;
      const ship = this.ships[idx];
      if (ship && ship.alive) {
        while (ship.alive) ship.takeHit();
        this.pendingEvents.push({ e: 'hit', x: ship.x, y: ship.y, by: -1, on: idx });
      }
    }
  }

  /** Clean a requested name and de-dupe it against the crew, so two blank
   *  joins become "Captain" and "Captain 2" instead of twins. */
  private uniqueName(raw: string): string {
    const base = cleanName(raw);
    let candidate = base;
    for (
      let n = 2;
      this.players.some((p) => p.name.toLowerCase() === candidate.toLowerCase());
      n++
    ) {
      const suffix = ` ${n}`;
      candidate = base.slice(0, 16 - suffix.length) + suffix;
    }
    return candidate;
  }

  /** Mid-battle join: spawn the newcomer like a respawn (spawn shield + brief
   *  helm lock in the arena center) and grow the roster on every client —
   *  far friendlier than the old hard "battle already underway" rejection for
   *  the 3rd friend who clicks the invite link a minute late. */
  private lateJoin(conn: DataConnection, rawName: string) {
    const player: HostPlayer = {
      conn,
      name: this.uniqueName(rawName),
      ship: 'small',
      ready: true,
      connected: true,
      bot: false,
      turn: 0,
      fire: false,
      dive: false,
    };
    this.players.push(player);
    const i = this.players.length - 1;

    const spot = this.pickRespawnSpot(SHIP_TYPES[player.ship].width);
    const spawn: ShipSpawn = {
      name: player.name,
      type: player.ship,
      color: crewColor(i, this.players),
      x: spot.x,
      y: spot.y,
      heading: Math.random() * Math.PI * 2,
    };
    this.spawns.push(spawn);
    this.ships.push(new Ship(spawn.x, spawn.y, spawn.heading, spawn.color, spawn.type));
    this.buffs.push({ doubleUntil: 0, speedUntil: 0, mgUntil: 0, mgArmed: false });
    this.buffView.push({ shield: 0, spd: false, dbl: false, mg: false, inv: true });
    this.scores.push({ time: 0, damage: 0, kills: 0 });
    this.scoreView.push({ score: 0, kills: 0 });
    this.ramCd.push(0);
    this.spawnUntil.push(this.clock + SPAWN_PROTECT);
    this.respawnAt.push(Infinity);
    this.moveFreezeUntil.push(this.clock + RESPAWN_FREEZE);
    this.diveCharge.push(DIVE_MAX);

    // Everyone already sailing learns about the new ship; the newcomer gets
    // the full battle state addressed to them. Both precede the next snapshot
    // on their ordered channels, so indices always line up.
    this.broadcast({ t: 'roster', ships: this.spawns });
    conn.send({
      t: 'start',
      islands: this.islands,
      ships: this.spawns,
      you: i,
      mode: this.mode,
    } satisfies H2CMsg);
  }

  // Ready is a courtesy signal ("done picking my ship"), not a gate — one idle
  // joiner must never deadlock the lobby. Unready captains sail in as-is; the
  // start-of-round freeze and spawn shield cover them like everyone else.
  private canStart(): boolean {
    return this.players.length >= 2;
  }

  private pushLobby() {
    const info: LobbyPlayerInfo[] = this.players.map((p) => ({
      name: p.name,
      ship: p.ship,
      ready: p.ready,
      bot: p.bot,
    }));
    this.players.forEach((p, i) => {
      if (p.conn?.open) p.conn.send({ t: 'lobby', players: info, you: i, mode: this.mode } satisfies H2CMsg);
    });
    this.cb.onLobby(info, 0, this.canStart(), this.mode);
  }

  private broadcast(msg: H2CMsg) {
    for (const p of this.players) {
      if (p.conn?.open) p.conn.send(msg);
    }
  }

  // ── Host: battle ────────────────────────────────────────────────────────────

  private beginRound() {
    this.spawns = this.players.map((p, i) => {
      const s = SPAWNS[i];
      return {
        name: p.name,
        type: p.ship,
        color: crewColor(i, this.players),
        x: s.x,
        y: s.y,
        // Random heading — everyone scatters a different way. A 2 s spawn shield
        // (below) keeps them safe while they sort themselves out.
        heading: Math.random() * Math.PI * 2,
      };
    });
    this.islands = generateIslands(WORLD_W, WORLD_H, SPAWNS.slice(0, this.players.length));
    this.ships = this.spawns.map((sp) => new Ship(sp.x, sp.y, sp.heading, sp.color, sp.type));
    this.ships[0].hullColor = YOU_COLOR; // your own hull is always pink (host is idx 0)
    this.freeze = START_FREEZE;
    this.balls = [];
    this.explosions = [];
    this.splashes = [];
    this.pendingEvents = [];
    this.wind = new Wind();
    this.endTimer = -1;
    this.snapshotAcc = 0;
    this.you = 0;

    // Reset power-up state for the round.
    this.clock = 0;
    this.pickups = [];
    this.buffs = this.spawns.map(() => ({
      doubleUntil: 0,
      speedUntil: 0,
      mgUntil: 0,
      mgArmed: false,
    }));
    this.buffView = this.spawns.map(() => ({ shield: 0, spd: false, dbl: false, mg: false, inv: true }));
    this.scores = this.spawns.map(() => ({ time: 0, damage: 0, kills: 0 }));
    this.scoreView = this.spawns.map(() => ({ score: 0, kills: 0 }));
    this.ramCd = this.spawns.map(() => 0);
    this.spawnUntil = this.spawns.map(() => SPAWN_PROTECT); // clock starts at 0
    this.respawnAt = this.spawns.map(() => Infinity);
    this.moveFreezeUntil = this.spawns.map(() => 0);
    this.timeLeft = this.mode === 'score' ? MATCH_DURATION : -1;
    this.diveCharge = this.spawns.map(() => DIVE_MAX);
    this.eyeR = EYE_MAX;
    this.pickupTimers = { ...ZERO_TIMERS };
    for (const type of PICKUP_ORDER) {
      const [lo, hi] = PICKUP_SPAWN[type];
      // Stagger initial spawns; health arrives soonest.
      this.pickupTimers[type] = lo * 0.5 + Math.random() * (hi - lo);
    }
    for (const p of this.players) {
      p.turn = 0;
      p.fire = false;
    }

    this.players.forEach((p, i) => {
      if (p.conn?.open) {
        p.conn.send({
          t: 'start',
          islands: this.islands,
          ships: this.spawns,
          you: i,
          mode: this.mode,
        } satisfies H2CMsg);
      }
    });

    this.phase = 'battle';
    this.cb.onStart();
    this.startLoop();
  }

  private hostUpdate(dt: number) {
    // Start-of-round pause: the world holds still (clock frozen, no inputs, no
    // shots) while every captain locates their pink ship.
    if (this.phase === 'battle' && this.freeze > 0) {
      this.freeze = Math.max(0, this.freeze - dt);
      this.updateBuffView();
      this.snapshotAcc += dt;
      if (this.snapshotAcc >= SNAPSHOT_INTERVAL) {
        this.snapshotAcc = 0;
        this.sendSnapshot();
      }
      this.tickEffects(dt);
      return;
    }

    this.clock += dt;
    this.wind.update(dt);
    this.driftWaves(dt);

    // Host reads its own keys; guests' inputs arrived over the wire; bots think.
    if (this.phase === 'battle') {
      this.players[0].turn =
        this.input.isDown('ArrowLeft') || this.input.isDown('KeyA')
          ? -1
          : this.input.isDown('ArrowRight') || this.input.isDown('KeyD')
            ? 1
            : 0;
      this.players[0].fire = this.input.isDown('Space');
      this.players[0].dive = this.input.isDown('ArrowDown') || this.input.isDown('KeyS');

      const eye =
        this.eyeR < EYE_MAX ? { x: WORLD_W / 2, y: WORLD_H / 2, r: this.eyeR } : undefined;
      this.players.forEach((p, i) => {
        if (!p.bot) return;
        const d = decideBot(
          this.ships[i],
          this.ships,
          this.islands,
          this.wind,
          eye,
          this.mode === 'survival',
          this.pickups,
          {
            dbl: this.buffs[i].doubleUntil > this.clock,
            mg: this.buffs[i].mgUntil > this.clock || this.buffs[i].mgArmed,
          },
        );
        p.turn = d.turn;
        p.fire = d.fire;
      });
    }

    this.ships.forEach((ship, i) => {
      // A freshly (re)spawned ship holds still for a beat before its captain
      // takes the helm — no steering, no drive, no diving, no guns.
      const frozen = this.moveFrozen(i);
      ship.boostFactor =
        this.phase === 'battle' && !frozen && this.buffs[i].speedUntil > this.clock ? SPEED_MULT : 1;
      const turn: Turn =
        this.phase === 'battle' && this.players[i].connected && !frozen ? this.players[i].turn : 0;

      // Submarine diving: hold to submerge while the charge lasts; the charge
      // refills on the surface. Other hulls stay pinned to depth 0.
      if (ship.type === 'submarine' && ship.alive) {
        const wantDive =
          !frozen && this.phase === 'battle' && this.players[i].connected && this.players[i].dive && this.diveCharge[i] > 0;
        ship.depth = Math.max(0, Math.min(1, ship.depth + ((wantDive ? 1 : -1) * dt) / DIVE_ANIM));
        if (ship.depth > 0.15 && wantDive) this.diveCharge[i] = Math.max(0, this.diveCharge[i] - dt);
        else if (ship.depth === 0) this.diveCharge[i] = Math.min(DIVE_MAX, this.diveCharge[i] + DIVE_REFILL * dt);
      }

      // Submarines are engine-powered — the wind never touches them. A frozen
      // ship has zero drive, so it stays put where it respawned.
      const sf = frozen ? 0 : ship.type === 'submarine' ? 1 : this.wind.speedFactor(ship.heading);
      ship.update(dt, turn, WORLD_W, WORLD_H, sf);
      // Running aground is fatal — islands are obstacles, not bumpers.
      // (Spawn-protected ships are unsinkable for their grace period.)
      if (ship.alive && this.spawnUntil[i] <= this.clock && shipHitsIsland(this.islands, ship)) {
        while (ship.alive) ship.takeHit();
        this.pendingEvents.push({ e: 'hit', x: ship.x, y: ship.y, by: -1, on: i });
      }
      if (this.phase === 'battle' && ship.alive) this.scores[i].time += dt; // survival score
    });

    if (this.phase === 'battle') this.updateRams(dt);
    if (this.phase === 'battle') this.updateWhirlpool(dt);
    if (this.phase === 'battle') this.updatePickups(dt);

    if (this.phase === 'battle') {
      this.ships.forEach((ship, i) => {
        if (!ship.alive || !this.players[i].connected) return;
        if (this.moveFrozen(i)) return; // just respawned — guns still holstered
        const b = this.buffs[i];
        const sub = ship.type === 'submarine';
        if (ship.depth > 0.15 && !sub) return; // only subs can shoot from underwater

        // Machine gun: rapid continuous fire (torpedo stream for submarines).
        if (b.mgUntil > this.clock) {
          if (ship.reload <= 0) {
            if (sub) this.fireTorpedo(ship, MG_RELOAD_SUB, 0);
            else this.fireSide(ship, 1, MG_RELOAD);
            this.pendingEvents.push({ e: 'fire', by: i });
          }
          return;
        }

        if (!this.players[i].fire || ship.reload > 0) return;

        if (b.mgArmed) {
          // The trigger shot arms 5 s of machine-gun fire.
          b.mgArmed = false;
          b.mgUntil = this.clock + MG_DURATION;
          if (sub) this.fireTorpedo(ship, MG_RELOAD_SUB, 0);
          else this.fireSide(ship, 1, MG_RELOAD);
        } else if (b.doubleUntil > this.clock) {
          if (sub) {
            // Double for a submarine: a two-torpedo spread off the bow.
            this.fireTorpedo(ship, RELOAD, 0.07);
          } else {
            this.fireBoth(ship);
          }
        } else if (sub) {
          this.fireTorpedo(ship, RELOAD, 0);
        } else {
          this.fireBroadside(ship);
        }
        this.pendingEvents.push({ e: 'fire', by: i });
      });
    }

    for (const ball of this.balls) {
      ball.update(dt, WORLD_W, WORLD_H);
      // After the round is decided, in-flight shots fly on harmlessly — no more
      // damage or score changes, so the final board matches the declared winner.
      if (ball.spent || this.phase !== 'battle') continue;
      for (const ship of this.ships) {
        if (ship === ball.owner || !ship.alive) continue;
        if (ship.depth > SUB_IMMUNE) continue; // shots pass over a submerged sub
        if (ship.containsPointWrapped(ball.x, ball.y, WORLD_W, WORLD_H)) {
          ball.spent = true;
          const si = this.ships.indexOf(ship);
          if (this.spawnUntil[si] > this.clock) {
            this.pendingEvents.push({ e: 'block', x: ball.x, y: ball.y }); // spawn shield
          } else if (ship.shield > 0) {
            ship.shield--; // a shield charge soaks the hit
            this.pendingEvents.push({ e: 'block', x: ball.x, y: ball.y });
          } else {
            const before = ship.health;
            ship.takeHit(ball.damage);
            const owner = this.ships.indexOf(ball.owner);
            if (owner >= 0) {
              this.scores[owner].damage += before - ship.health;
              if (before > 0 && ship.health <= 0) this.scores[owner].kills++; // sinking shot
            }
            this.pendingEvents.push({ e: 'hit', x: ball.x, y: ball.y, by: owner, on: si });
          }
          break;
        }
      }
      if (!ball.spent && islandHitsPoint(this.islands, ball.x, ball.y)) {
        ball.spent = true;
        this.pendingEvents.push({ e: 'splash', x: ball.x, y: ball.y });
      }
    }
    this.balls = this.balls.filter((b) => !b.spent);

    // Leaderboard: sunk ships respawn in the middle of the map after a pause —
    // but once the storm sets in for the finale, deaths are permanent. Do this
    // after all damage for the tick so a ship that died this frame starts its
    // death timer immediately.
    this.timeLeft = this.mode === 'score' ? Math.max(0, MATCH_DURATION - this.clock) : -1;
    if (this.phase === 'battle' && this.mode === 'score' && !this.stormActive()) this.updateRespawns();

    this.updateBuffView();

    // Apply this tick's events locally (sounds + effects), then queue for guests.
    if (this.pendingEvents.length > 0) this.applyEvents(this.pendingEvents);

    // Match end. Leaderboard is timed — the clock running out ends it, whoever
    // leads. Survivor ends when one ship is left afloat, or every human captain
    // is dead (nobody wants to spectate bots finishing each other off).
    if (this.phase === 'battle') {
      let matchOver: boolean;
      if (this.mode === 'score') {
        matchOver = this.clock >= MATCH_DURATION;
      } else {
        const alive = this.ships.filter((s) => s.alive).length;
        const humansAlive = this.players.some((p, i) => !p.bot && this.ships[i].alive);
        matchOver = alive <= 1 || !humansAlive;
      }
      if (matchOver && this.endTimer < 0) this.endTimer = END_DELAY;
      if (this.endTimer >= 0) {
        this.endTimer -= dt;
        if (this.endTimer <= 0) {
          // Highest weighted score wins; take it from the same ranked board the
          // UI shows so the declared winner always matches the top of the list.
          const board = this.getLeaderboard();
          const winner = board.length ? board[0].idx : -1;
          this.sendSnapshot(); // final positions, fully sunk hulls
          this.broadcast({ t: 'end', winner });
          this.phase = 'end';
          this.cb.onEnd(winner >= 0 ? this.spawns[winner].name : null);
        }
      }
    }

    if (this.phase === 'battle') {
      this.snapshotAcc += dt;
      if (this.snapshotAcc >= SNAPSHOT_INTERVAL) {
        this.snapshotAcc = 0;
        this.sendSnapshot();
      }
    }

    this.tickEffects(dt);
  }

  /** Fire one broadside off the given side, setting the reload timer. */
  private fireSide(shooter: Ship, side: 1 | -1, reload: number) {
    const dir = shooter.heading + (side * Math.PI) / 2;
    const fx = Math.cos(shooter.heading);
    const fy = Math.sin(shooter.heading);
    const sx = Math.cos(dir);
    const sy = Math.sin(dir);

    const reach = muzzleReach(shooter.width);
    for (const along of gunOffsets(shooter.guns, shooter.length)) {
      this.balls.push(
        new Cannonball(
          shooter.x + fx * along + sx * reach,
          shooter.y + fy * along + sy * reach,
          dir,
          shooter,
        ),
      );
    }
    shooter.reload = reload;
  }

  private fireBroadside(shooter: Ship) {
    this.fireSide(shooter, 1, RELOAD); // guns live on the starboard rail
  }

  /** Double-broadside power-up: fire both sides at once. */
  private fireBoth(shooter: Ship) {
    this.fireSide(shooter, 1, RELOAD);
    this.fireSide(shooter, -1, RELOAD);
  }

  /** Submarine bow torpedo(es); spread > 0 launches a symmetric pair. */
  private fireTorpedo(shooter: Ship, reload: number, spread: number) {
    const dirs = spread > 0 ? [shooter.heading - spread, shooter.heading + spread] : [shooter.heading];
    for (const dir of dirs) {
      this.balls.push(
        new Cannonball(
          shooter.x + Math.cos(shooter.heading) * (shooter.length / 2 + 4),
          shooter.y + Math.sin(shooter.heading) * (shooter.length / 2 + 4),
          dir,
          shooter,
          true,
        ),
      );
    }
    shooter.reload = reload;
  }

  // ── Ramming (bow-spike) ───────────────────────────────────────────────────

  private updateRams(dt: number) {
    for (let i = 0; i < this.ramCd.length; i++) this.ramCd[i] = Math.max(0, this.ramCd[i] - dt);

    for (let i = 0; i < this.ships.length; i++) {
      const A = this.ships[i];
      if (!A.alive) continue;
      if (A.depth > SUB_IMMUNE) continue; // a submerged sub passes under hulls
      for (let j = i + 1; j < this.ships.length; j++) {
        const B = this.ships[j];
        if (!B.alive || B.depth > SUB_IMMUNE) continue;

        // Nearest-image delta so ramming works across the wrap seam too.
        const dx = wrapDelta(B.x - A.x, WORLD_W);
        const dy = wrapDelta(B.y - A.y, WORLD_H);
        const dist = Math.hypot(dx, dy) || 0.001;
        const contact = A.length * 0.42 + B.length * 0.42;
        if (dist >= contact) continue;

        // Shove the hulls apart so they don't interpenetrate — but never into an
        // island (knockback must not become a free grounding kill).
        const nx = dx / dist;
        const ny = dy / dist;
        const push = (contact - dist) * 0.5;
        const ax = A.x - nx * push;
        const ay = A.y - ny * push;
        if (!shipHitsIsland(this.islands, { x: ax, y: ay, width: A.width })) {
          A.x = ax;
          A.y = ay;
        }
        const bx = B.x + nx * push;
        const by = B.y + ny * push;
        if (!shipHitsIsland(this.islands, { x: bx, y: by, width: B.width })) {
          B.x = bx;
          B.y = by;
        }

        if (this.ramCd[i] > 0 || this.ramCd[j] > 0) continue; // just separated recently

        // Whose bow (the whole curved front) is driving into the other?
        const aBow = Math.cos(A.heading) * nx + Math.sin(A.heading) * ny >= RAM_BOW_COS;
        const bBow = Math.cos(B.heading) * -nx + Math.sin(B.heading) * -ny >= RAM_BOW_COS;
        const mx = (A.x + B.x) / 2;
        const my = (A.y + B.y) / 2;
        let hit = false;
        // Emit the hit tagged with rammer (by) and victim (on) so each ram is
        // audible only to the two ships in it.
        const ram = (ai: number, vi: number, selfDmg: number) => {
          if (this.applyRam(ai, vi, RAM_DMG, selfDmg)) {
            this.pendingEvents.push({ e: 'hit', x: mx, y: my, by: ai, on: vi });
            hit = true;
          }
        };
        if (aBow && bBow) {
          // Bow-to-bow: both hulls take the full ram, no extra return damage.
          ram(i, j, 0);
          ram(j, i, 0);
        } else if (aBow) {
          ram(i, j, RAM_SELF_DMG);
        } else if (bBow) {
          ram(j, i, RAM_SELF_DMG);
        }
        if (hit) {
          this.ramCd[i] = RAM_CD;
          this.ramCd[j] = RAM_CD;
        }
      }
    }
  }

  /** Apply a ram from ship `ai` to `vi`; returns true if damage landed. */
  private applyRam(ai: number, vi: number, dmg: number, selfDmg: number): boolean {
    const attacker = this.ships[ai];
    const victim = this.ships[vi];
    if (this.spawnUntil[vi] > this.clock) return false; // spawn-protected
    if (victim.shield > 0) {
      victim.shield--; // a shield charge soaks the ram
      return false;
    }
    const before = victim.health;
    victim.takeHit(dmg);
    this.scores[ai].damage += before - victim.health;
    if (before > 0 && victim.health <= 0) this.scores[ai].kills++;
    // The rammer pays the return damage (unless shielded).
    if (selfDmg > 0 && attacker.shield <= 0) attacker.takeHit(selfDmg);
    return true;
  }

  // ── Respawns (host, Leaderboard) ──────────────────────────────────────────────

  /** True while ship `i` is in its post-(re)spawn hold and can't move or fire. */
  private moveFrozen(i: number): boolean {
    return this.mode === 'score' && this.moveFreezeUntil[i] > this.clock;
  }

  /** A sunk ship stays down for DEATH_PAUSE, then returns to the middle of the
   *  map with the round-start spawn shield + glow and a brief helm-lock. */
  private updateRespawns() {
    for (let i = 0; i < this.ships.length; i++) {
      if (this.ships[i].alive) continue;
      if (!this.players[i].connected) continue; // a captain who left stays sunk
      if (this.respawnAt[i] === Infinity) {
        this.respawnAt[i] = this.clock + DEATH_PAUSE; // just went down — start the count
      } else if (this.clock >= this.respawnAt[i]) {
        this.respawn(i);
      }
    }
  }

  private respawn(i: number) {
    const ship = this.ships[i];
    const spot = this.pickRespawnSpot(ship.width);
    ship.x = spot.x;
    ship.y = spot.y;
    ship.heading = Math.random() * Math.PI * 2;
    ship.health = ship.maxHealth;
    ship.sinkProgress = 0;
    ship.shield = 0;
    ship.depth = 0;
    ship.boostFactor = 1;
    ship.reload = 0;
    ship.gunHighlight = false;
    ship.wake = [];
    // A respawn is a clean slate — old power-ups don't carry over.
    this.buffs[i] = { doubleUntil: 0, speedUntil: 0, mgUntil: 0, mgArmed: false };
    this.diveCharge[i] = DIVE_MAX;
    this.spawnUntil[i] = this.clock + SPAWN_PROTECT; // shield bubble + glow, like the start
    this.moveFreezeUntil[i] = this.clock + RESPAWN_FREEZE; // hold the helm for a beat
    this.respawnAt[i] = Infinity;
  }

  /** A clear point in the central 50% of the arena — off the islands and not
   *  right on top of a ship that's still afloat. */
  private pickRespawnSpot(width: number): { x: number; y: number } {
    const span = 1 - 2 * RESPAWN_BAND;
    let spot = { x: WORLD_W / 2, y: WORLD_H / 2 };
    for (let attempt = 0; attempt < 30; attempt++) {
      const x = WORLD_W * (RESPAWN_BAND + Math.random() * span);
      const y = WORLD_H * (RESPAWN_BAND + Math.random() * span);
      if (shipHitsIsland(this.islands, { x, y, width })) continue;
      spot = { x, y };
      if (this.ships.every((s) => !s.alive || Math.hypot(s.x - x, s.y - y) > 140)) break;
    }
    return spot;
  }

  // ── Whirlpool (host) ────────────────────────────────────────────────────────

  /** True once the Leaderboard storm has set in (its final-stretch sudden death). */
  private stormActive(): boolean {
    return this.mode === 'score' && this.clock >= MATCH_DURATION - STORM_WINDOW;
  }

  /** Maelstrom strength for the current clock: 0 before it forms → 1 at full.
   *  Leaderboard holds the storm until the last STORM_WINDOW seconds, then ramps
   *  it to full right as the clock runs out. Survivor keeps the slow build. */
  private whirlStrength(): number {
    if (this.mode === 'score') {
      const start = MATCH_DURATION - STORM_WINDOW;
      if (this.clock < start) return 0;
      return Math.min((this.clock - start) / STORM_WINDOW, 1);
    }
    if (this.clock < WHIRL_START) return 0;
    return Math.min((this.clock - WHIRL_START) / WHIRL_RAMP, 1);
  }

  private updateWhirlpool(dt: number) {
    const s = this.whirlStrength();
    this.eyeR = EYE_MAX - (EYE_MAX - EYE_MIN) * s;
    if (s <= 0) return;

    const cx = WORLD_W / 2;
    const cy = WORLD_H / 2;
    this.ships.forEach((ship) => {
      if (!ship.alive) return;
      const dx = cx - ship.x;
      const dy = cy - ship.y;
      const d = Math.hypot(dx, dy) || 0.001;
      const nx = dx / d; // unit vector toward the eye
      const ny = dy / d;
      const outside = d > this.eyeR;

      // Inward current + tangential swirl — strong outside the eye, gentle within.
      const pull = PULL_MAX * s * (outside ? 1 : 0.15);
      const sw = SWIRL_FRAC * pull;
      const tx = ship.x + (nx * pull - ny * sw) * dt;
      const ty = ship.y + (ny * pull + nx * sw) * dt;
      // Don't let the current sweep a ship onto a lethal island.
      if (!shipHitsIsland(this.islands, { x: tx, y: ty, width: ship.width })) {
        ship.x = tx;
        ship.y = ty;
      }
    });
  }

  // ── Power-ups (host) ────────────────────────────────────────────────────────

  private updatePickups(dt: number) {
    // Expire uncollected pickups so they relocate and the map stays fresh.
    for (const p of this.pickups) p.ttl -= dt;
    this.pickups = this.pickups.filter((p) => p.ttl > 0);

    // Fewer captains afloat → fewer bounties, so goodies thin out as the fight
    // narrows down to the survivors. Leaderboard keeps the water far busier.
    const score = this.mode === 'score';
    const cap = score ? MAX_PICKUPS_SCORE : MAX_PICKUPS;
    const alive = this.ships.reduce((n, s) => n + (s.alive ? 1 : 0), 0);
    const maxActive = Math.max(1, Math.round((cap * alive) / this.ships.length));

    // Timed spawns per type — quicker to reappear in Leaderboard.
    for (const type of PICKUP_ORDER) {
      this.pickupTimers[type] -= dt;
      if (this.pickupTimers[type] > 0) continue;
      const [lo, hi] = PICKUP_SPAWN[type];
      this.pickupTimers[type] = (lo + Math.random() * (hi - lo)) * (score ? PICKUP_HASTE_SCORE : 1);
      if (this.pickups.length >= maxActive) continue;
      const spot = this.pickDifficultSpot();
      if (spot) this.pickups.push({ id: this.pickupId++, type, x: spot.x, y: spot.y, ttl: PICKUP_TTL });
    }

    // Collection: any living ship overlapping a pickup collects it.
    for (const p of this.pickups) {
      for (let i = 0; i < this.ships.length; i++) {
        const ship = this.ships[i];
        if (!ship.alive || ship.depth > 0.3) continue; // must surface to grab bounties
        if (Math.hypot(ship.x - p.x, ship.y - p.y) < PICKUP_R + ship.width * 0.7) {
          this.applyPickup(i, p.type);
          this.pendingEvents.push({ e: 'grab', x: p.x, y: p.y, p: p.type });
          p.ttl = 0;
          break;
        }
      }
    }
    this.pickups = this.pickups.filter((p) => p.ttl > 0);
  }

  /** A tempting-but-dangerous spot: usually just off an island's lethal shore. */
  private pickDifficultSpot(): { x: number; y: number } | null {
    for (let attempt = 0; attempt < 24; attempt++) {
      let x: number, y: number;
      if (this.islands.length && Math.random() < 0.6) {
        const isl = this.islands[Math.floor(Math.random() * this.islands.length)];
        const c = isl.circles[Math.floor(Math.random() * isl.circles.length)];
        const a = Math.random() * Math.PI * 2;
        const d = c.r + 28 + Math.random() * 30; // just off the sand: risky but grabbable
        x = c.x + Math.cos(a) * d;
        y = c.y + Math.sin(a) * d;
      } else {
        x = 120 + Math.random() * (WORLD_W - 240);
        y = 120 + Math.random() * (WORLD_H - 240);
      }
      if (x < 40 || x > WORLD_W - 40 || y < 40 || y > WORLD_H - 40) continue;
      if (islandHitsPoint(this.islands, x, y)) continue; // not on land
      if (this.pickups.some((q) => Math.hypot(q.x - x, q.y - y) < 90)) continue; // spread out
      return { x, y };
    }
    return null;
  }

  private applyPickup(i: number, type: PickupType) {
    const ship = this.ships[i];
    const b = this.buffs[i];
    switch (type) {
      case 'health':
        ship.health = Math.min(ship.maxHealth, ship.health + 1);
        break;
      case 'shield':
        ship.shield = SHIELD_HITS;
        break;
      case 'speed':
        b.speedUntil = this.clock + SPEED_DURATION;
        break;
      case 'double':
        b.doubleUntil = this.clock + DOUBLE_DURATION;
        break;
      case 'machinegun':
        b.mgArmed = true;
        break;
    }
  }

  private updateBuffView() {
    for (let i = 0; i < this.ships.length; i++) {
      const b = this.buffs[i];
      this.buffView[i] = {
        shield: this.ships[i].shield,
        spd: b.speedUntil > this.clock,
        dbl: b.doubleUntil > this.clock,
        mg: b.mgUntil > this.clock,
        inv: this.spawnUntil[i] > this.clock,
      };
      const sc = this.scores[i];
      this.scoreView[i] = {
        // Survivor: only time afloat counts. Leaderboard: the weighted mix.
        score:
          this.mode === 'survival'
            ? sc.time
            : sc.time * SCORE_TIME + sc.damage * SCORE_DAMAGE + sc.kills * SCORE_KILL,
        kills: sc.kills,
      };
    }
  }

  /** True while a battle is running or on its result screen (leaderboard shows). */
  get inBattle(): boolean {
    return this.phase === 'battle' || this.phase === 'end';
  }

  /** Live standings. Leaderboard mode: weighted score. Survivor: alive ships
   *  outrank sunk ones, then longest time afloat. */
  getLeaderboard(): LeaderboardEntry[] {
    const rows = this.ships.map((s, i) => ({
      idx: i,
      name: this.spawns[i]?.name ?? '',
      color: this.spawns[i]?.color ?? '#fff',
      score: Math.round(this.scoreView[i]?.score ?? 0),
      kills: this.scoreView[i]?.kills ?? 0,
      alive: s.alive,
      you: i === this.you,
    }));
    if (this.mode === 'survival') {
      return rows.sort(
        (a, b) =>
          Number(b.alive) - Number(a.alive) ||
          b.score - a.score ||
          this.ships[b.idx].health - this.ships[a.idx].health,
      );
    }
    return rows.sort((a, b) => b.score - a.score);
  }

  private sendSnapshot() {
    const msg: H2CMsg = {
      t: 'state',
      ships: this.ships.map((s, i) => ({
        x: s.x,
        y: s.y,
        heading: s.heading,
        health: s.health,
        sink: s.sinkProgress,
        shield: s.shield,
        spd: this.buffView[i]?.spd ?? false,
        dbl: this.buffView[i]?.dbl ?? false,
        mg: this.buffView[i]?.mg ?? false,
        inv: this.buffView[i]?.inv ?? false,
        depth: s.depth,
        charge: this.diveCharge[i] / DIVE_MAX,
        score: this.scoreView[i]?.score ?? 0,
        kills: this.scoreView[i]?.kills ?? 0,
      })),
      balls: this.balls.map((b) => ({ x: b.x, y: b.y, vx: b.vx, vy: b.vy, tp: b.torpedo })),
      wind: this.wind.direction,
      events: this.pendingEvents,
      pickups: this.pickups.map((p) => ({ t: p.type, x: p.x, y: p.y })),
      eye: this.eyeR,
      freeze: this.freeze,
      timeLeft: this.timeLeft,
    };
    this.pendingEvents = [];
    this.broadcast(msg);
  }

  // ── Guest ───────────────────────────────────────────────────────────────────

  private onHostMessage(msg: H2CMsg, code: string) {
    if (!this.active || !msg || typeof msg !== 'object') return;

    switch (msg.t) {
      case 'reject':
        this.fail(msg.reason);
        break;

      case 'lobby':
        if (this.phase === 'connecting') {
          this.phase = 'lobby';
          this.cb.onRoomReady(code.toUpperCase().trim());
        }
        this.you = msg.you;
        this.mode = msg.mode;
        this.cb.onLobby(msg.players, msg.you, false, msg.mode);
        break;

      case 'start':
        this.islands = msg.islands;
        this.spawns = msg.ships;
        this.you = msg.you;
        this.mode = msg.mode;
        this.ships = msg.ships.map((sp) => new Ship(sp.x, sp.y, sp.heading, sp.color, sp.type));
        this.ships[this.you].hullColor = YOU_COLOR; // your own hull is always pink
        this.freeze = START_FREEZE;
        this.timeLeft = msg.mode === 'score' ? MATCH_DURATION : -1;
        this.targets = msg.ships.map((sp) => ({
          x: sp.x,
          y: sp.y,
          heading: sp.heading,
          health: SHIP_TYPES[sp.type].maxHealth,
          sink: 0,
          shield: 0,
          spd: false,
          dbl: false,
          mg: false,
          inv: true,
          depth: 0,
          charge: 1,
          score: 0,
          kills: 0,
        }));
        this.buffView = msg.ships.map(() => ({ shield: 0, spd: false, dbl: false, mg: false, inv: true }));
        this.scoreView = msg.ships.map(() => ({ score: 0, kills: 0 }));
        this.guestCharge = msg.ships.map(() => 1);
        this.eyeR = EYE_MAX;
        this.pickups = [];
        this.balls = [];
        this.ballStates = [];
        this.explosions = [];
        this.splashes = [];
        this.wind = new Wind();
        this.lastSent = { turn: 0, fire: false, dive: false };
        this.phase = 'battle';
        this.cb.onStart();
        this.startLoop();
        break;

      case 'roster':
        // A captain joined mid-battle: append their ship (indices never shrink
        // or reorder mid-round). Ignored outside battle — a late joiner also
        // receives the broadcast just before their own tailored 'start'.
        if (this.phase !== 'battle') break;
        for (let i = this.ships.length; i < msg.ships.length; i++) {
          const sp = msg.ships[i];
          this.ships.push(new Ship(sp.x, sp.y, sp.heading, sp.color, sp.type));
          this.targets.push({
            x: sp.x,
            y: sp.y,
            heading: sp.heading,
            health: SHIP_TYPES[sp.type].maxHealth,
            sink: 0,
            shield: 0,
            spd: false,
            dbl: false,
            mg: false,
            inv: true,
            depth: 0,
            charge: 1,
            score: 0,
            kills: 0,
          });
          this.buffView.push({ shield: 0, spd: false, dbl: false, mg: false, inv: true });
          this.scoreView.push({ score: 0, kills: 0 });
          this.guestCharge.push(1);
        }
        this.spawns = msg.ships;
        break;

      case 'state':
        this.targets = msg.ships;
        this.ballStates = msg.balls;
        this.pickups = msg.pickups.map((p) => ({ id: 0, type: p.t, x: p.x, y: p.y, ttl: 1 }));
        this.eyeR = msg.eye;
        this.freeze = msg.freeze;
        this.timeLeft = msg.timeLeft;
        this.lastSnapAt = performance.now();
        this.wind.direction = msg.wind;
        this.applyEvents(msg.events);
        break;

      case 'end':
        this.phase = 'end';
        this.cb.onEnd(msg.winner >= 0 ? this.spawns[msg.winner].name : null);
        break;

      case 'toLobby':
        this.phase = 'lobby';
        this.stopLoop();
        this.cb.onToLobby();
        break;
    }
  }

  private guestUpdate(dt: number) {
    if (this.phase === 'battle') {
      const turn: Turn =
        this.input.isDown('ArrowLeft') || this.input.isDown('KeyA')
          ? -1
          : this.input.isDown('ArrowRight') || this.input.isDown('KeyD')
            ? 1
            : 0;
      const fire = this.input.isDown('Space');
      const dive = this.input.isDown('ArrowDown') || this.input.isDown('KeyS');
      this.inputAcc += dt;
      if (
        turn !== this.lastSent.turn ||
        fire !== this.lastSent.fire ||
        dive !== this.lastSent.dive ||
        this.inputAcc >= INPUT_INTERVAL
      ) {
        this.inputAcc = 0;
        this.lastSent = { turn, fire, dive };
        if (this.conn?.open) this.conn.send({ t: 'input', turn, fire, dive } satisfies C2HMsg);
      }
    }

    // Glide each hull toward its latest snapshot; snap across world-wrap jumps.
    const k = 1 - Math.exp(-SMOOTH_RATE * dt);
    this.ships.forEach((ship, i) => {
      const t = this.targets[i];
      if (!t) return;
      const dx = t.x - ship.x;
      const dy = t.y - ship.y;
      if (Math.abs(dx) > SNAP_DIST || Math.abs(dy) > SNAP_DIST) {
        ship.x = t.x;
        ship.y = t.y;
        ship.heading = t.heading;
      } else {
        ship.x += dx * k;
        ship.y += dy * k;
        ship.heading += angleDiff(t.heading, ship.heading) * k;
      }
      ship.health = t.health;
      ship.sinkProgress = t.sink;
      ship.shield = t.shield;
      ship.depth = t.depth;
      this.guestCharge[i] = t.charge;
      this.buffView[i] = { shield: t.shield, spd: t.spd, dbl: t.dbl, mg: t.mg, inv: t.inv };
      this.scoreView[i] = { score: t.score, kills: t.kills };
    });

    this.driftWaves(dt);
    this.tickEffects(dt);
  }

  // ── Shared loop & effects ───────────────────────────────────────────────────

  private startLoop() {
    if (this.looping) return;
    this.looping = true;
    this.lastTime = performance.now();
    requestAnimationFrame(this.frame);
  }

  private stopLoop() {
    this.looping = false;
  }

  private frame = (now: number) => {
    if (!this.active || !this.looping) return;
    const dt = Math.min((now - this.lastTime) / 1000, MAX_DT);
    this.lastTime = now;
    if (this.isHost) this.hostUpdate(dt);
    else this.guestUpdate(dt);
    this.render();
    requestAnimationFrame(this.frame);
  };

  private driftWaves(dt: number) {
    const wdx = Math.cos(this.wind.direction) * WAVE_DRIFT * dt;
    const wdy = Math.sin(this.wind.direction) * WAVE_DRIFT * dt;
    for (const wave of this.waves) {
      wave.x = (wave.x + wdx + WORLD_W) % WORLD_W;
      wave.y = (wave.y + wdy + WORLD_H) % WORLD_H;
    }
  }

  private applyEvents(events: GameEvent[]) {
    for (const ev of events) {
      if (ev.e === 'fire') {
        // Only your own guns are audible — a fleet of bots firing would be a din.
        if (ev.by === this.you) this.sounds.fire();
      } else if (ev.e === 'hit') {
        this.explosions.push(new Explosion(ev.x, ev.y)); // every hit still flashes
        // ...but only hits you're part of make a sound: taking one reads as a
        // heavier "get hit", landing one as a lighter "my hit".
        if (ev.on === this.you) this.sounds.getHit();
        else if (ev.by === this.you) this.sounds.myHit();
      } else {
        this.splashes.push(new Splash(ev.x, ev.y));
      }
    }
  }

  private tickEffects(dt: number) {
    for (const ex of this.explosions) ex.update(dt);
    this.explosions = this.explosions.filter((ex) => !ex.done);
    for (const sp of this.splashes) sp.update(dt);
    this.splashes = this.splashes.filter((sp) => !sp.done);
  }

  private fail(message: string) {
    if (!this.active) return;
    this.leave();
    this.cb.onError(message);
  }

  // ── Rendering ───────────────────────────────────────────────────────────────

  // Canvas backing store is device pixels (high-DPI); logic works in CSS px.
  private get dpr(): number {
    return Math.min(window.devicePixelRatio || 1, 2);
  }

  private get viewW(): number {
    return this.ctx.canvas.width / this.dpr;
  }

  private get viewH(): number {
    return this.ctx.canvas.height / this.dpr;
  }

  private render() {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); // pixel-sharp on scaled displays
    const cw = this.viewW;
    const ch = this.viewH;
    const fit = Math.min(cw / WORLD_W, ch / WORLD_H);

    // Backdrop (visible as letterbox bars; overdrawn entirely in follow mode).
    ctx.fillStyle = '#16293f';
    ctx.fillRect(0, 0, cw, ch);

    // Sample wakes once per frame (not once per drawn tile).
    const now = performance.now();
    for (const ship of this.ships) this.updateWake(ship, now);

    const me = this.ships[this.you];
    if (fit < FOLLOW_BELOW && me) {
      // The whole view is open sea — painting it once here (not per tile)
      // avoids a hairline seam where wrapped tiles meet.
      ctx.fillStyle = '#2e6da6';
      ctx.fillRect(0, 0, cw, ch);
      // Follow camera (phones / tiny windows): zoom in and keep your ship
      // centered. Floors at "one world tile fills the screen" per axis, so the
      // viewport never exceeds the world and at most 2×2 wrapped tiles show.
      const scale = Math.max(FOLLOW_SCALE, cw / WORLD_W, ch / WORLD_H);
      const vw = cw / scale;
      const vh = ch / scale;
      const camX = (((me.x - vw / 2) % WORLD_W) + WORLD_W) % WORLD_W;
      const camY = (((me.y - vh / 2) % WORLD_H) + WORLD_H) % WORLD_H;
      ctx.save();
      ctx.scale(scale, scale);
      ctx.translate(-camX, -camY);
      const xs = camX + vw > WORLD_W ? [0, WORLD_W] : [0];
      const ys = camY + vh > WORLD_H ? [0, WORLD_H] : [0];
      for (const tx of xs) {
        for (const ty of ys) {
          ctx.save();
          ctx.translate(tx, ty);
          this.drawWorld(now);
          ctx.restore();
        }
      }
      ctx.restore();
    } else {
      // Letterbox: the whole arena scaled to fit, as always on big screens.
      const ox = (cw - WORLD_W * fit) / 2;
      const oy = (ch - WORLD_H * fit) / 2;
      ctx.save();
      ctx.translate(ox, oy);
      ctx.scale(fit, fit);
      ctx.beginPath();
      ctx.rect(0, 0, WORLD_W, WORLD_H);
      ctx.clip();
      ctx.fillStyle = '#2e6da6';
      ctx.fillRect(0, 0, WORLD_W, WORLD_H);
      this.drawWorld(now);
      ctx.restore();

      // World border so the wrap edge is visible.
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
      ctx.lineWidth = 2;
      ctx.strokeRect(ox, oy, WORLD_W * fit, WORLD_H * fit);
    }

    this.drawHud();
    if (this.isTouchDevice && this.phase === 'battle') this.drawTouchControls();
  }

  /** Everything in world space: sea, islands, pickups, shots, ships, effects.
   *  Called once per visible wrapped tile with the transform already set. */
  private drawWorld(now: number) {
    const ctx = this.ctx;

    // Waves (the sea itself is painted by render(), once for the whole view).
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 1.5;
    for (const wave of this.waves) {
      ctx.beginPath();
      ctx.arc(wave.x, wave.y, wave.r, Math.PI * 0.15, Math.PI * 0.85);
      ctx.stroke();
    }

    for (const island of this.islands) drawIsland(ctx, island);

    this.drawPickups();

    if (this.isHost) {
      for (const ball of this.balls) ball.draw(ctx);
    } else {
      // Extrapolate a touch past the last snapshot so 30 Hz balls fly smoothly.
      const age = Math.min((performance.now() - this.lastSnapAt) / 1000, 0.12);
      for (const b of this.ballStates) {
        drawCannonball(ctx, b.x + b.vx * age, b.y + b.vy * age, b.vx, b.vy, b.tp);
      }
    }

    // Fading wakes first, so hulls draw over them.
    for (const ship of this.ships) this.drawWake(ship, now);

    this.ships.forEach((ship, i) => {
      // A submerged submarine is invisible to everyone but its own captain.
      if (i !== this.you && ship.depth > SUB_HIDDEN) return;
      if (ship.sinkProgress < 1) this.drawShipBuffs(ship, i); // aura under the hull
      ship.gunHighlight = this.buffView[i]?.dbl ?? false; // gold guns during double
      ship.drawWrapped(ctx, WORLD_W, WORLD_H); // ghost across edges = seamless wrap
      if (ship.sinkProgress < 1) {
        this.drawShipHealth(ship);
        this.drawBuffIcons(ship, i);
        this.drawNameTag(ship, this.spawns[i]?.name ?? '', i === this.you);
        if (i === this.you) {
          this.drawYouMarker(ship);
          if (ship.type === 'submarine') this.drawDiveMeter(ship, i);
        }
      }
    });

    for (const ex of this.explosions) ex.draw(ctx);
    for (const sp of this.splashes) sp.draw(ctx);

    this.drawWhirlpool();
  }

  /** On-screen thumb buttons during multiplayer battles (touch devices). */
  private drawTouchControls() {
    const ctx = this.ctx;
    const btns = layoutTouchButtons(this.viewW, this.viewH);
    drawTouchBtn(ctx, btns.left, '←', this.input.isDown('ArrowLeft'));
    drawTouchBtn(ctx, btns.right, '→', this.input.isDown('ArrowRight'));
    drawTouchBtn(ctx, btns.fire, '🔥', this.input.isDown('Space'));
    if (this.ships[this.you]?.type === 'submarine') {
      drawTouchBtn(ctx, btns.dive, '🤿', this.input.isDown('ArrowDown'));
    }
  }

  /** The maelstrom: a swirling danger wash outside the calm circular eye. */
  private drawWhirlpool() {
    if (this.eyeR >= EYE_MAX) return;
    const ctx = this.ctx;
    const cx = WORLD_W / 2;
    const cy = WORLD_H / 2;
    const now = performance.now();

    ctx.save();

    // Danger tint everywhere outside the eye (rect with a reversed-arc hole).
    const pulse = 0.2 + 0.06 * Math.sin(now / 500);
    ctx.fillStyle = `rgba(26, 78, 92, ${pulse})`;
    ctx.beginPath();
    ctx.rect(0, 0, WORLD_W, WORLD_H);
    ctx.arc(cx, cy, this.eyeR, 0, Math.PI * 2, true);
    ctx.fill();

    // Swirling current arcs to sell the pull.
    const rot = now / 1400;
    ctx.strokeStyle = 'rgba(190, 235, 235, 0.22)';
    ctx.lineWidth = 2;
    for (let ring = 0; ring < 4; ring++) {
      const r = this.eyeR + 32 + ring * 78;
      ctx.beginPath();
      ctx.arc(cx, cy, r, rot + ring * 1.3, rot + ring * 1.3 + Math.PI * 1.3);
      ctx.stroke();
    }

    // Bright eye boundary.
    ctx.strokeStyle = 'rgba(120, 230, 235, 0.9)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, this.eyeR, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();
  }

  private drawPickups() {
    const ctx = this.ctx;
    const bob = Math.sin(performance.now() / 300) * 2;
    for (const p of this.pickups) {
      const meta = PICKUP_META[p.type];
      const yy = p.y + bob;
      ctx.beginPath();
      ctx.arc(p.x, yy, PICKUP_R + 3, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(p.x, yy, PICKUP_R, 0, Math.PI * 2);
      ctx.fillStyle = meta.color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 15px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(meta.icon, p.x, yy + 1);

      // Label so it's obvious what the bounty grants.
      ctx.font = 'bold 10px system-ui, sans-serif';
      ctx.textBaseline = 'top';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.65)';
      ctx.strokeText(meta.label, p.x, yy + PICKUP_R + 3);
      ctx.fillStyle = '#fff';
      ctx.fillText(meta.label, p.x, yy + PICKUP_R + 3);
    }
  }

  /** Auras drawn beneath a ship: spawn shield, power-up shield, speed streak. */
  private drawShipBuffs(ship: Ship, i: number) {
    const v = this.buffView[i];
    if (!v) return;
    const ctx = this.ctx;

    // Spawn window: ONLY your own ship glows — a bright pink pulsing halo —
    // so there's exactly one glowing ship on screen: yours.
    if (v.inv && i === this.you) {
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 160);
      ctx.save();
      ctx.globalAlpha = 0.25 + 0.2 * pulse;
      ctx.fillStyle = '#ff8ec6';
      ctx.beginPath();
      ctx.arc(ship.x, ship.y, ship.length * (0.95 + 0.15 * pulse), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.95;
      ctx.strokeStyle = '#ff4fa0';
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.arc(ship.x, ship.y, ship.length * (0.95 + 0.15 * pulse), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    if (v.spd) {
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = '#ffe14d';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      const bx = ship.x - Math.cos(ship.heading) * ship.length * 0.5;
      const by = ship.y - Math.sin(ship.heading) * ship.length * 0.5;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx - Math.cos(ship.heading) * 16, by - Math.sin(ship.heading) * 16);
      ctx.stroke();
      ctx.restore();
    }

    if (v.shield > 0) {
      ctx.save();
      ctx.globalAlpha = 0.45 + 0.25 * Math.sin(performance.now() / 150);
      ctx.strokeStyle = '#6fd3ff';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(ship.x, ship.y, ship.length * 0.72, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  /** Short readable tags above the health bar showing active power-ups. */
  private drawBuffIcons(ship: Ship, i: number) {
    const v = this.buffView[i];
    if (!v) return;
    const tags: string[] = [];
    if (v.spd) tags.push('2×SPD');
    if (v.dbl) tags.push('DBL');
    if (v.mg) tags.push('RAPID');
    if (v.shield > 0) tags.push(`SHLD${v.shield}`);
    if (!tags.length) return;

    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 1 - ship.sinkProgress;
    ctx.font = 'bold 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const text = tags.join(' ');
    const y = ship.y - ship.length * 0.62 - 4;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.strokeText(text, ship.x, y);
    ctx.fillStyle = '#ffe07a';
    ctx.fillText(text, ship.x, y);
    ctx.restore();
  }

  /** Sample the hull's stern position into its wake trail (no wake underwater). */
  private updateWake(ship: Ship, now: number) {
    // Prune old foam.
    while (ship.wake.length && now - ship.wake[0].t > 1100) ship.wake.shift();
    if (ship.sinkProgress > 0 || ship.depth > 0.3) return;
    const last = ship.wake[ship.wake.length - 1];
    if (last && now - last.t < 28) return;
    const sx = ship.x - Math.cos(ship.heading) * ship.length * 0.45;
    const sy = ship.y - Math.sin(ship.heading) * ship.length * 0.45;
    if (last && Math.hypot(sx - last.x, sy - last.y) < 2) return; // barely moving
    ship.wake.push({ x: sx, y: sy, t: now });
  }

  /** Fading white foam behind the hull — every ship leaves a wake as it sails. */
  private drawWake(ship: Ship, now: number) {
    if (!ship.wake.length) return;
    const ctx = this.ctx;
    for (const p of ship.wake) {
      const age = (now - p.t) / 1100; // 0 fresh → 1 gone
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.5 + 3.5 * age, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 255, 255, ${(1 - age) * 0.28})`;
      ctx.fill();
    }
  }

  /** A small bobbing red triangle above your own ship so you always find yourself. */
  private drawYouMarker(ship: Ship) {
    const ctx = this.ctx;
    const bob = Math.sin(performance.now() / 250) * 2.5;
    const y = ship.y - ship.length * 0.62 - 24 + bob;
    ctx.save();
    ctx.globalAlpha = 1 - ship.sinkProgress;
    ctx.fillStyle = '#e8281e';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(ship.x, y + 9); // tip points down at the ship
    ctx.lineTo(ship.x - 7, y - 3);
    ctx.lineTo(ship.x + 7, y - 3);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  /** Cyan dive-charge bar under your submarine's health bar. */
  private drawDiveMeter(ship: Ship, i: number) {
    const ctx = this.ctx;
    const frac = this.isHost
      ? (this.diveCharge[i] ?? 0) / DIVE_MAX
      : (this.guestCharge[i] ?? 0);
    const w = 40;
    const y = ship.y - ship.length * 0.62 + 7;
    ctx.save();
    ctx.globalAlpha = 1 - ship.sinkProgress;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(ship.x - w / 2 - 1, y - 1, w + 2, 5);
    ctx.fillStyle = '#4fd8ef';
    ctx.fillRect(ship.x - w / 2, y, w * Math.max(0, Math.min(1, frac)), 3);
    ctx.restore();
  }

  /** A segmented health bar floating just above the hull, colored by how
   *  hurt the ship is — so you can pick off the weakest target at a glance. */
  private drawShipHealth(ship: Ship) {
    const ctx = this.ctx;
    const n = ship.maxHealth;
    const segW = 6;
    const segH = 4;
    const gap = 1.5;
    const totalW = n * (segW + gap) - gap;
    const x0 = ship.x - totalW / 2;
    const y = ship.y - ship.length * 0.62;
    const frac = ship.health / ship.maxHealth;
    const col = frac > 0.5 ? '#5bd15f' : frac > 0.25 ? '#e6b422' : '#e8503a';

    ctx.save();
    ctx.globalAlpha = 1 - ship.sinkProgress;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(x0 - 1.5, y - 1.5, totalW + 3, segH + 3);
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
      ctx.fillRect(x0 + i * (segW + gap), y, segW, segH);
      const f = Math.max(0, Math.min(1, ship.health - i)); // show fractional damage
      if (f > 0) {
        ctx.fillStyle = col;
        ctx.fillRect(x0 + i * (segW + gap), y, segW * f, segH);
      }
    }
    ctx.restore();
  }

  private drawNameTag(ship: Ship, name: string, isYou: boolean) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = (1 - ship.sinkProgress) * 0.9;
    ctx.font = `${isYou ? 'bold ' : ''}13px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillText(name, ship.x + 1, ship.y + ship.length * 0.55 + 1);
    ctx.fillStyle = isYou ? '#ffd75e' : '#fff';
    ctx.fillText(name, ship.x, ship.y + ship.length * 0.55);
    ctx.restore();
  }

  private drawHud() {
    // Per-ship health lives on the hulls now; standings live in the HTML
    // leaderboard panel. The canvas HUD shows the wind compass and, once the
    // storm is closing, a warning banner.
    this.drawWindIndicator();

    // Leaderboard match countdown, top-center. Turns red for the final 15 s.
    if (this.timeLeft >= 0) {
      const ctx = this.ctx;
      const m = Math.floor(this.timeLeft / 60);
      const s = Math.floor(this.timeLeft % 60);
      const text = `${m}:${String(s).padStart(2, '0')}`;
      ctx.save();
      ctx.font = 'bold 26px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const x = this.viewW / 2;
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.strokeText(text, x, 12);
      ctx.fillStyle = this.timeLeft <= 15 ? '#ff7a7a' : '#ffffff';
      ctx.fillText(text, x, 12);
      ctx.restore();
    }

    if (this.eyeR < EYE_MAX) {
      const ctx = this.ctx;
      ctx.save();
      ctx.font = 'bold 15px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const text = '🌀 MAELSTROM — THE SEA IS PULLING IN';
      const x = this.viewW / 2;
      const y = this.timeLeft >= 0 ? 46 : 14; // clear the match clock when it's shown
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.strokeText(text, x, y);
      ctx.fillStyle = '#ff9db3';
      ctx.fillText(text, x, y);
      ctx.restore();
    }

    // Start-of-round countdown — just the number; your glowing pink ship is
    // the only glow on screen, which is the real "you are here".
    if (this.phase === 'battle' && this.freeze > 0) {
      const ctx = this.ctx;
      const x = this.viewW / 2;
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = 'bold 64px system-ui, sans-serif';
      const n = String(Math.ceil(this.freeze));
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.65)';
      ctx.strokeText(n, x, this.viewH * 0.34);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(n, x, this.viewH * 0.34);
      ctx.restore();
    }
  }

  private drawWindIndicator() {
    const ctx = this.ctx;
    const cx = 52;
    const cy = 100; // below the mute button in the top-left corner
    const r = 28;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    const hx = Math.cos(this.wind.direction);
    const hy = Math.sin(this.wind.direction);

    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx - hx * (r - 9), cy - hy * (r - 9));
    ctx.lineTo(cx + hx * (r - 11), cy + hy * (r - 11));
    ctx.stroke();

    const tipX = cx + hx * (r - 6);
    const tipY = cy + hy * (r - 6);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - hx * 10 - hy * 5.5, tipY - hy * 10 + hx * 5.5);
    ctx.lineTo(tipX - hx * 10 + hy * 5.5, tipY - hy * 10 - hx * 5.5);
    ctx.closePath();
    ctx.fill();

    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.fillText('Wind', cx, cy + r + 14);

    const me = this.ships[this.you];
    if (me) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
      if (me.type === 'submarine') {
        ctx.fillText('Engine', cx, cy + r + 32); // subs ignore the wind
      } else {
        const pct = Math.round(this.wind.speedFactor(me.heading) * 100);
        ctx.fillText(`Sails ${pct}%`, cx, cy + r + 32);
      }
    }
  }
}

function cleanName(name: string): string {
  const n = String(name).trim().slice(0, 16);
  return n.length > 0 ? n : 'Captain';
}
