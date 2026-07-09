// Online multiplayer session: up to 4 ships in a free-for-all arena with
// islands for cover. Host-authoritative — the host runs the whole simulation
// and broadcasts snapshots; guests send steering/fire inputs and render the
// latest state with smoothing.
//
// Unlike single player (where the world IS the canvas), multiplayer uses a
// fixed logical world so every peer sees identical geometry regardless of
// their window size; each client letterboxes it to fit.

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
  type PeerHandle,
  type ShipSpawn,
  type ShipState,
} from './net';
import { Ship, SHIP_TYPES, type ShipTypeName, type Turn } from './ship';
import { Wind } from './wind';
import type { DataConnection } from 'peerjs';

export const WORLD_W = 1600;
export const WORLD_H = 1000;

export const MAX_PLAYERS = 11; // one human host + up to 10 bots (or more humans)
const MAX_DT = 0.05;
const RELOAD = 1.4; // s between broadsides, same for everyone
const SNAPSHOT_INTERVAL = 1 / 30;
const INPUT_INTERVAL = 0.05; // guest input heartbeat
const END_DELAY = 1.7; // let the sinking animation play before declaring a winner
const WAVE_DRIFT = 14;
const SMOOTH_RATE = 14; // guest position smoothing (higher = snappier)
const SNAP_DIST = 250; // beyond this a target jump is a wrap/teleport — snap, don't glide

export const PLAYER_COLORS = [
  '#8b5a2b', // brown
  '#7a1f1f', // red
  '#2e5d34', // green
  '#4a3d7a', // purple
  '#b8860b', // goldenrod
  '#1f6f7a', // teal
  '#a34a7a', // magenta
  '#5a6b1f', // olive
  '#9c4a1f', // sienna
  '#37507a', // steel blue
  '#7a1f5a', // plum
];

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
];
const SHIP_NAMES = Object.keys(SHIP_TYPES) as ShipTypeName[];

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
}

export interface MpCallbacks {
  /** In the lobby now. Host: code is '' until the broker responds. Guest: real code. */
  onRoomReady(code: string): void;
  /** Host only: the shareable code arrived (string), or the broker was
   *  unreachable so this is an offline, bots-only room (null). */
  onRoomCode(code: string | null): void;
  onLobby(players: LobbyPlayerInfo[], you: number, canStart: boolean): void;
  onStart(): void;
  /** winnerName null = mutual destruction. */
  onEnd(winnerName: string | null): void;
  onToLobby(): void;
  /** Fatal — the session is dead (host gone, room not found, …). */
  onError(message: string): void;
}

interface Sounds {
  fire: () => void;
  hit: () => void;
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
  private lastSent = { turn: 0 as Turn, fire: false };

  // Shared battle state (host simulates; guest mirrors)
  private you = 0;
  private islands: IslandData[] = [];
  private spawns: ShipSpawn[] = [];
  private ships: Ship[] = [];
  private wind = new Wind();
  private explosions: Explosion[] = [];
  private splashes: Splash[] = [];
  private waves: Wave[] = [];
  private looping = false;
  private lastTime = 0;

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
  }

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
      { conn: null, name: cleanName(name), ship: 'small', ready: false, connected: true, bot: false, turn: 0, fire: false },
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
      ship: SHIP_NAMES[Math.floor(Math.random() * SHIP_NAMES.length)],
      ready: true,
      connected: true,
      bot: true,
      turn: 0,
      fire: false,
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

  /** Host only: fill every empty slot with AI captains. */
  fillBots() {
    if (!this.isHost || this.phase !== 'lobby') return;
    for (let bot = this.makeBot(); bot; bot = this.makeBot()) this.players.push(bot);
    this.pushLobby();
  }

  /** Host only: dismiss a bot from the lobby. */
  removeBot(index: number) {
    if (!this.isHost || this.phase !== 'lobby' || !this.players[index]?.bot) return;
    this.players.splice(index, 1);
    this.pushLobby();
  }

  /** Host only: launch the battle (lobby must be all-ready with 2+ players). */
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
  }

  // ── Host: lobby & connections ───────────────────────────────────────────────

  private acceptConnection(conn: DataConnection) {
    if (this.phase !== 'lobby' || this.players.length >= MAX_PLAYERS) {
      const reason =
        this.phase === 'lobby' ? 'Room is full.' : 'A battle is already underway.';
      conn.on('open', () => {
        conn.send({ t: 'reject', reason } satisfies H2CMsg);
        setTimeout(() => conn.close(), 200);
      });
      return;
    }

    conn.on('data', (data) => this.onGuestMessage(conn, data as C2HMsg));
    conn.on('close', () => this.onGuestGone(conn));
  }

  private onGuestMessage(conn: DataConnection, msg: C2HMsg) {
    if (!this.active || !msg || typeof msg !== 'object') return;
    const idx = this.players.findIndex((p) => p.conn === conn);

    if (msg.t === 'hello') {
      if (idx !== -1) return; // already joined
      if (this.phase !== 'lobby' || this.players.length >= MAX_PLAYERS) {
        conn.send({ t: 'reject', reason: 'Room is full.' } satisfies H2CMsg);
        setTimeout(() => conn.close(), 200);
        return;
      }
      this.players.push({
        conn,
        name: cleanName(msg.name),
        ship: 'small',
        ready: false,
        connected: true,
        bot: false,
        turn: 0,
        fire: false,
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
        this.pendingEvents.push({ e: 'hit', x: ship.x, y: ship.y });
      }
    }
  }

  private canStart(): boolean {
    return this.players.length >= 2 && this.players.every((p) => p.ready);
  }

  private pushLobby() {
    const info: LobbyPlayerInfo[] = this.players.map((p) => ({
      name: p.name,
      ship: p.ship,
      ready: p.ready,
      bot: p.bot,
    }));
    this.players.forEach((p, i) => {
      if (p.conn?.open) p.conn.send({ t: 'lobby', players: info, you: i } satisfies H2CMsg);
    });
    this.cb.onLobby(info, 0, this.canStart());
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
        color: PLAYER_COLORS[i],
        x: s.x,
        y: s.y,
        heading: Math.atan2(WORLD_H / 2 - s.y, WORLD_W / 2 - s.x),
      };
    });
    this.islands = generateIslands(WORLD_W, WORLD_H, SPAWNS.slice(0, this.players.length));
    this.ships = this.spawns.map((sp) => new Ship(sp.x, sp.y, sp.heading, sp.color, sp.type));
    this.balls = [];
    this.explosions = [];
    this.splashes = [];
    this.pendingEvents = [];
    this.wind = new Wind();
    this.endTimer = -1;
    this.snapshotAcc = 0;
    this.you = 0;
    for (const p of this.players) {
      p.turn = 0;
      p.fire = false;
    }

    this.players.forEach((p, i) => {
      if (p.conn?.open) {
        p.conn.send({ t: 'start', islands: this.islands, ships: this.spawns, you: i } satisfies H2CMsg);
      }
    });

    this.phase = 'battle';
    this.cb.onStart();
    this.startLoop();
  }

  private hostUpdate(dt: number) {
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

      this.players.forEach((p, i) => {
        if (!p.bot) return;
        const d = decideBot(this.ships[i], this.ships, this.islands, this.wind);
        p.turn = d.turn;
        p.fire = d.fire;
      });
    }

    this.ships.forEach((ship, i) => {
      const turn: Turn = this.phase === 'battle' && this.players[i].connected ? this.players[i].turn : 0;
      ship.update(dt, turn, WORLD_W, WORLD_H, this.wind.speedFactor(ship.heading));
      // Running aground is fatal — islands are obstacles, not bumpers.
      if (ship.alive && shipHitsIsland(this.islands, ship)) {
        while (ship.alive) ship.takeHit();
        this.pendingEvents.push({ e: 'hit', x: ship.x, y: ship.y });
      }
    });

    if (this.phase === 'battle') {
      this.ships.forEach((ship, i) => {
        if (ship.alive && this.players[i].connected && this.players[i].fire && ship.reload <= 0) {
          this.fireBroadside(ship);
          this.pendingEvents.push({ e: 'fire' });
        }
      });
    }

    for (const ball of this.balls) {
      ball.update(dt);
      if (ball.spent) continue;
      for (const ship of this.ships) {
        if (ship === ball.owner || !ship.alive) continue;
        if (ship.containsPoint(ball.x, ball.y)) {
          ball.spent = true;
          ship.takeHit(ball.damage);
          this.pendingEvents.push({ e: 'hit', x: ball.x, y: ball.y });
          break;
        }
      }
      if (!ball.spent && islandHitsPoint(this.islands, ball.x, ball.y)) {
        ball.spent = true;
        this.pendingEvents.push({ e: 'splash', x: ball.x, y: ball.y });
      }
    }
    this.balls = this.balls.filter((b) => !b.spent);

    // Apply this tick's events locally (sounds + effects), then queue for guests.
    if (this.pendingEvents.length > 0) this.applyEvents(this.pendingEvents);

    // Round end: one ship left afloat — or every human captain is dead
    // (nobody wants to spectate bots finishing each other off).
    if (this.phase === 'battle') {
      const alive = this.ships.filter((s) => s.alive).length;
      const humansAlive = this.players.some((p, i) => !p.bot && this.ships[i].alive);
      if ((alive <= 1 || !humansAlive) && this.endTimer < 0) this.endTimer = END_DELAY;
      if (this.endTimer >= 0) {
        this.endTimer -= dt;
        if (this.endTimer <= 0) {
          // Healthiest survivor takes the win (covers multiple bots surviving).
          let winner = -1;
          let best = 0;
          this.ships.forEach((s, i) => {
            if (s.alive && s.health > best) {
              best = s.health;
              winner = i;
            }
          });
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

  private fireBroadside(shooter: Ship) {
    // Aim the broadside at the nearest living enemy; default starboard if alone.
    let side = 1;
    let best = Infinity;
    for (const other of this.ships) {
      if (other === shooter || !other.alive) continue;
      const d = Math.hypot(other.x - shooter.x, other.y - shooter.y);
      if (d < best) {
        best = d;
        const bearing = Math.atan2(other.y - shooter.y, other.x - shooter.x);
        side = Math.sin(bearing - shooter.heading) >= 0 ? 1 : -1;
      }
    }
    const dir = shooter.heading + (side * Math.PI) / 2;

    const fx = Math.cos(shooter.heading);
    const fy = Math.sin(shooter.heading);
    const sx = Math.cos(dir);
    const sy = Math.sin(dir);

    for (let i = 0; i < shooter.guns; i++) {
      const along = (i / (shooter.guns - 1) - 0.5) * (shooter.length / 2);
      this.balls.push(
        new Cannonball(
          shooter.x + fx * along + sx * (shooter.width / 2),
          shooter.y + fy * along + sy * (shooter.width / 2),
          dir,
          shooter,
        ),
      );
    }
    shooter.reload = RELOAD;
  }

  private sendSnapshot() {
    const msg: H2CMsg = {
      t: 'state',
      ships: this.ships.map((s) => ({
        x: s.x,
        y: s.y,
        heading: s.heading,
        health: s.health,
        sink: s.sinkProgress,
      })),
      balls: this.balls.map((b) => ({ x: b.x, y: b.y, vx: b.vx, vy: b.vy })),
      wind: this.wind.direction,
      events: this.pendingEvents,
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
        this.cb.onLobby(msg.players, msg.you, false);
        break;

      case 'start':
        this.islands = msg.islands;
        this.spawns = msg.ships;
        this.you = msg.you;
        this.ships = msg.ships.map((sp) => new Ship(sp.x, sp.y, sp.heading, sp.color, sp.type));
        this.targets = msg.ships.map((sp) => ({
          x: sp.x,
          y: sp.y,
          heading: sp.heading,
          health: SHIP_TYPES[sp.type].maxHealth,
          sink: 0,
        }));
        this.balls = [];
        this.ballStates = [];
        this.explosions = [];
        this.splashes = [];
        this.wind = new Wind();
        this.lastSent = { turn: 0, fire: false };
        this.phase = 'battle';
        this.cb.onStart();
        this.startLoop();
        break;

      case 'state':
        this.targets = msg.ships;
        this.ballStates = msg.balls;
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
      this.inputAcc += dt;
      if (turn !== this.lastSent.turn || fire !== this.lastSent.fire || this.inputAcc >= INPUT_INTERVAL) {
        this.inputAcc = 0;
        this.lastSent = { turn, fire };
        if (this.conn?.open) this.conn.send({ t: 'input', turn, fire } satisfies C2HMsg);
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
        this.sounds.fire();
      } else if (ev.e === 'hit') {
        this.explosions.push(new Explosion(ev.x, ev.y));
        this.sounds.hit();
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

  private render() {
    const ctx = this.ctx;
    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;
    const scale = Math.min(cw / WORLD_W, ch / WORLD_H);
    const ox = (cw - WORLD_W * scale) / 2;
    const oy = (ch - WORLD_H * scale) / 2;

    // Letterbox backdrop.
    ctx.fillStyle = '#16293f';
    ctx.fillRect(0, 0, cw, ch);

    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(scale, scale);
    ctx.beginPath();
    ctx.rect(0, 0, WORLD_W, WORLD_H);
    ctx.clip();

    // Sea + waves.
    ctx.fillStyle = '#2e6da6';
    ctx.fillRect(0, 0, WORLD_W, WORLD_H);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 1.5;
    for (const wave of this.waves) {
      ctx.beginPath();
      ctx.arc(wave.x, wave.y, wave.r, Math.PI * 0.15, Math.PI * 0.85);
      ctx.stroke();
    }

    for (const island of this.islands) drawIsland(ctx, island);

    if (this.isHost) {
      for (const ball of this.balls) ball.draw(ctx);
    } else {
      // Extrapolate a touch past the last snapshot so 30 Hz balls fly smoothly.
      const age = Math.min((performance.now() - this.lastSnapAt) / 1000, 0.12);
      for (const b of this.ballStates) {
        drawCannonball(ctx, b.x + b.vx * age, b.y + b.vy * age, b.vx, b.vy);
      }
    }

    this.ships.forEach((ship, i) => {
      ship.draw(ctx);
      if (ship.sinkProgress < 1) {
        this.drawShipHealth(ship);
        this.drawNameTag(ship, this.spawns[i]?.name ?? '', i === this.you);
      }
    });

    for (const ex of this.explosions) ex.draw(ctx);
    for (const sp of this.splashes) sp.draw(ctx);

    ctx.restore();

    // World border so the wrap edge is visible.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.lineWidth = 2;
    ctx.strokeRect(ox, oy, WORLD_W * scale, WORLD_H * scale);

    this.drawHud();
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
    const ctx = this.ctx;
    const segW = 14;
    const segH = 10;
    const gap = 3;
    const margin = 16;

    this.ships.forEach((ship, i) => {
      const spawn = this.spawns[i];
      if (!spawn) return;
      const y = margin + i * (segH + 12);
      const totalW = ship.maxHealth * (segW + gap) - gap;
      const x0 = ctx.canvas.width - margin - totalW;

      ctx.font = `${i === this.you ? 'bold ' : ''}13px system-ui, sans-serif`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = i === this.you ? '#ffd75e' : '#fff';
      const youMark = i === this.you ? ' (you)' : '';
      ctx.fillText(`${spawn.name}${youMark} · ${spawn.type}`, x0 - 22, y + segH / 2);

      ctx.fillStyle = spawn.color;
      ctx.fillRect(x0 - 16, y, 10, segH);

      for (let s = 0; s < ship.maxHealth; s++) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
        ctx.fillRect(x0 + s * (segW + gap), y, segW, segH);
        const f = Math.max(0, Math.min(1, ship.health - s));
        if (f > 0) {
          ctx.fillStyle = '#4caf50';
          ctx.fillRect(x0 + s * (segW + gap), y, segW * f, segH);
        }
      }
    });

    this.drawWindIndicator();
  }

  private drawWindIndicator() {
    const ctx = this.ctx;
    const cx = 52;
    const cy = 52;
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
      const pct = Math.round(this.wind.speedFactor(me.heading) * 100);
      ctx.fillText(`Sails ${pct}%`, cx, cy + r + 32);
    }
  }
}

function cleanName(name: string): string {
  const n = String(name).trim().slice(0, 16);
  return n.length > 0 ? n : 'Captain';
}
