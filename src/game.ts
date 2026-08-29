import { decideTurn, wantsToFire, type AiOptions } from './ai';
import { Cannonball } from './cannonball';
import { Explosion } from './explosion';
import type { Input } from './input';
import type { PickupType } from './net';
import { DIVE, gunOffsets, muzzleReach, RAM, SAIL_TYPES, Ship, wrapDelta, YOU_COLOR, type ShipTypeName, type Turn } from './ship';
import { drawThreatArc, haptic, incomingThreats, requestGameFullscreen, TouchControls, touchActive, turnToward } from './touchui';
import { Wind } from './wind';

const MAX_DT = 0.05;
const WAVE_DRIFT = 14;

// ── Ammo magazine (practice-mode variation, player only) ──────────────────────
// Instead of an automatic per-broadside cooldown, the player carries a finite
// magazine that holds exactly MAG_BROADSIDES broadsides. Ammo is counted in
// individual bullets so the pip HUD scales with ship size (capacity = guns ×
// MAG_BROADSIDES). Each broadside/torpedo consumes one broadside's worth, and
// the whole magazine can be emptied back-to-back with no gap between shots.
// When it can't field a full broadside the player presses R for a
// MAG_RELOAD-second refill to full.
const MAG_BROADSIDES = 3; // full magazine = 3 broadsides for every hull
const MAG_RELOAD = 2; // s to reload and refill the magazine

// ── Power-ups (practice mode) ───────────────────────────────────────────────
// A lighter version of the multiplayer bounty system (see multiplayer.ts):
// same pickup types and effects, just two hulls and no host/guest sync — a
// buff is a plain per-ship countdown timer instead of a clock-timestamp.
const MG_RELOAD = 0.16; // machine-gun cadence
const MG_RELOAD_SUB = 0.35; // rapid-fire cadence for torpedoes (slower — a torpedo hits much harder than a cannonball)
const MG_DURATION = 5; // s of continuous fire
const DOUBLE_DURATION = 10; // s of firing both sides at once
const SPEED_DURATION = 8; // s of double speed
const SPEED_MULT = 2;
const RANGE_DURATION = 10; // s of double cannon range
const RANGE_MULT = 2;
const DAMAGE_DURATION = 10; // s of double cannon damage
const DAMAGE_MULT = 2;
const SHIELD_HITS = 4; // incoming shots absorbed before it breaks
const SHIELD_DURATION = 7; // s before it lapses
const MAX_PICKUPS = 7; // hard ceiling on bounties afloat at once, everywhere
const PICKUP_TTL = 20; // s before an uncollected pickup relocates
const PICKUP_R = 15; // px

const PICKUP_SPAWN: Record<PickupType, [number, number]> = {
  health: [6, 10],
  shield: [15, 24],
  speed: [13, 21],
  double: [17, 27],
  machinegun: [22, 34],
  range: [16, 25],
  damage: [18, 28],
};
const PICKUP_ORDER = Object.keys(PICKUP_SPAWN) as PickupType[];

const PICKUP_META: Record<PickupType, { icon: string; color: string; label: string }> = {
  health: { icon: '➕', color: '#e8503a', label: '+1 HEALTH' },
  shield: { icon: '⛨', color: '#3aa0e8', label: 'SHIELD ×4' },
  speed: { icon: '⚡', color: '#e8c53a', label: '2× SPEED' },
  double: { icon: '⇄', color: '#7bd15f', label: '2× FIRE' },
  machinegun: { icon: '⁘', color: '#e8892a', label: 'RAPID FIRE' },
  range: { icon: '🎯', color: '#b06fe8', label: '2× RANGE' },
  damage: { icon: '💥', color: '#c81d47', label: '2× DAMAGE' },
};
const ZERO_TIMERS: Record<PickupType, number> = {
  health: 0,
  shield: 0,
  speed: 0,
  double: 0,
  machinegun: 0,
  range: 0,
  damage: 0,
};

interface Pickup {
  id: number;
  type: PickupType;
  x: number;
  y: number;
  ttl: number;
}

/** One hull's active power-up windows, each a plain countdown to 0. */
interface Buff {
  doubleT: number;
  speedT: number;
  mgT: number;
  mgArmed: boolean; // rapid fire picked up, waiting for the next trigger shot
  rangeT: number;
  damageT: number;
  shieldT: number;
}

function freshBuff(): Buff {
  return { doubleT: 0, speedT: 0, mgT: 0, mgArmed: false, rangeT: 0, damageT: 0, shieldT: 0 };
}

export const DIFFICULTIES = {
  easy: { label: 'Easy', reload: 2.2, leadShots: false, windAware: false },
  medium: { label: 'Medium', reload: 1.8, leadShots: true, windAware: false },
  hard: { label: 'Hard', reload: 1.4, leadShots: true, windAware: true },
} as const;

export type DifficultyName = keyof typeof DIFFICULTIES;

// Steering-wheel hub: touches closer than this to the screen center don't
// steer, so a thumb resting mid-screen can't jitter the helm.
const WHEEL_DEADZONE = 40;

const PLAYER_COLOR = YOU_COLOR; // your ship is always pink — easy to spot
const ENEMY_COLOR = '#7a1f1f';

interface Wave {
  x: number;
  y: number;
  r: number;
}

export class Game {
  private ctx: CanvasRenderingContext2D;
  private input: Input;
  private phase: 'idle' | 'battle' = 'idle';
  private difficulty: DifficultyName = 'easy';
  private player!: Ship;
  private enemy!: Ship;
  private cannonballs: Cannonball[] = [];
  private explosions: Explosion[] = [];
  private waves: Wave[] = [];
  private wind = new Wind();
  private lastTime = 0;
  private gameOverFired = false;
  private diveCharge: number = DIVE.max; // player submarine dive charge
  private ramCd = 0; // s until this pair of hulls can ram-damage again
  private ammo = 0; // player bullets remaining in the magazine
  private ammoCap = 0; // player magazine capacity (guns × MAG_BROADSIDES)
  private reloadTimer = 0; // s left on the manual reload, 0 when not reloading
  private pickups: Pickup[] = [];
  private pickupId = 0;
  private pickupTimers: Record<PickupType, number> = { ...ZERO_TIMERS };
  private playerBuff: Buff = freshBuff();
  private enemyBuff: Buff = freshBuff();

  /** Set by main.ts; called once when the battle ends (won = enemy sunk). */
  onGameOver: ((won: boolean) => void) | null = null;
  /** Called when the player fires a broadside. */
  onCannonFire: (() => void) | null = null;
  /** Called each time a hit lands; the flag is true when the player was the one
   *  hit (so the UI can play a heavier "you got hit" cue) and false when the
   *  player dealt it. */
  onHit: ((youWereHit: boolean) => void) | null = null;
  /** Called when the player grabs a power-up bounty. */
  onPickup: ((type: PickupType) => void) | null = null;
  /** When non-null (survivor mode), renders the kill count in the HUD. */
  survivorKills: number | null = null;
  /** While true another renderer (multiplayer) owns the canvas; this loop idles. */
  suspended = false;

  // Actual touch use, not capability — a touchscreen laptop on the keyboard
  // gets desktop rules. Seeded from any touch earlier this session, upgraded
  // by the first real touch event after construction.
  private isTouchDevice = touchActive();
  private touch = new TouchControls();

  constructor(ctx: CanvasRenderingContext2D, input: Input) {
    this.ctx = ctx;
    this.input = input;

    const w = this.viewW;
    const h = this.viewH;

    for (let i = 0; i < 40; i++) {
      this.waves.push({
        x: Math.random() * w,
        y: Math.random() * h,
        r: 6 + Math.random() * 10,
      });
    }

    // Registered regardless of detection: if a touch ever arrives, controls
    // must work — detection only decides whether buttons show before then.
    ctx.canvas.addEventListener('touchstart', this.onTouch, { passive: true });
    ctx.canvas.addEventListener('touchmove', this.onTouch, { passive: true });
    ctx.canvas.addEventListener('touchend', this.onTouch, { passive: true });
    ctx.canvas.addEventListener('touchcancel', this.onTouch, { passive: true });
    window.addEventListener(
      'touchstart',
      () => {
        this.isTouchDevice = true;
      },
      { passive: true, once: true },
    );
  }

  private onTouch = (e: TouchEvent) => {
    this.isTouchDevice = true;
    if (this.phase !== 'battle') {
      this.touch.reset();
      this.input.setVirtual(false, false, false, false);
      return;
    }
    this.touch.update(e, this.ctx.canvas, this.viewW, this.viewH, this.player?.type === 'submarine');
  };

  startBattle(playerType: ShipTypeName, enemyType: ShipTypeName | 'random', difficulty: DifficultyName) {
    // Called from a menu tap, so the fullscreen request has gesture context.
    if (this.isTouchDevice) void requestGameFullscreen();
    this.touch.reset();
    const w = this.viewW;
    const h = this.viewH;
    let resolvedEnemy = enemyType;
    if (resolvedEnemy === 'random') {
      resolvedEnemy = SAIL_TYPES[Math.floor(Math.random() * SAIL_TYPES.length)];
    }

    this.difficulty = difficulty;
    this.player = new Ship(w * 0.3, h * 0.6, -Math.PI / 4, PLAYER_COLOR, playerType);
    this.enemy = new Ship(w * 0.7, h * 0.3, Math.PI * 0.75, ENEMY_COLOR, resolvedEnemy);
    this.ammoCap = this.player.guns * MAG_BROADSIDES;
    this.ammo = this.ammoCap;
    this.reloadTimer = 0;
    this.diveCharge = DIVE.max;
    this.ramCd = 0;
    this.cannonballs = [];
    this.explosions = [];
    this.wind = new Wind();
    this.gameOverFired = false;
    this.survivorKills = null;
    this.pickups = [];
    this.playerBuff = freshBuff();
    this.enemyBuff = freshBuff();
    // Stagger initial spawns so the water isn't empty for the first stretch.
    for (const type of PICKUP_ORDER) {
      const [lo, hi] = PICKUP_SPAWN[type];
      this.pickupTimers[type] = lo * 0.5 + Math.random() * (hi - lo);
    }
    this.phase = 'battle';
  }

  /** Survivor mode: replace the enemy with a new ship without resetting the player. */
  spawnNextEnemy(type: ShipTypeName, difficulty: DifficultyName) {
    const w = this.viewW;
    const h = this.viewH;
    let ex: number, ey: number;
    let attempts = 0;
    do {
      ex = 50 + Math.random() * (w - 100);
      ey = 50 + Math.random() * (h - 100);
      attempts++;
    } while (Math.hypot(ex - this.player.x, ey - this.player.y) < 300 && attempts < 20);

    // Face roughly toward the player.
    const heading = Math.atan2(this.player.y - ey, this.player.x - ex);
    this.enemy = new Ship(ex, ey, heading, ENEMY_COLOR, type);
    this.difficulty = difficulty;
    this.ammo = this.ammoCap; // fresh magazine for each new foe
    this.reloadTimer = 0;
    this.ramCd = 0;
    this.cannonballs = [];
    this.explosions = [];
    this.gameOverFired = false;
    this.enemyBuff = freshBuff(); // a fresh foe carries no leftover buffs
  }

  private get over(): boolean {
    return this.phase === 'battle' && (!this.player.alive || !this.enemy.alive);
  }

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

  start() {
    this.lastTime = performance.now();
    requestAnimationFrame(this.frame);
  }

  onResize(w: number, h: number) {
    this.waves.forEach((wave) => {
      wave.x = Math.random() * w;
      wave.y = Math.random() * h;
    });
  }

  private frame = (now: number) => {
    const dt = Math.min((now - this.lastTime) / 1000, MAX_DT);
    this.lastTime = now;
    if (!this.suspended) {
      this.update(dt);
      this.input.clearPressed();
      this.render();
    }
    requestAnimationFrame(this.frame);
  };

  private update(dt: number) {
    if (this.phase === 'idle') return;

    const w = this.viewW;
    const h = this.viewH;

    if (this.over && !this.gameOverFired) {
      this.gameOverFired = true;
      this.onGameOver?.(this.enemy.alive === false);
    }

    const diff = DIFFICULTIES[this.difficulty];
    const aiOpts = { leadShots: diff.leadShots, windAware: diff.windAware, wind: this.wind };

    this.wind.update(dt);
    const wdx = Math.cos(this.wind.direction) * WAVE_DRIFT * dt;
    const wdy = Math.sin(this.wind.direction) * WAVE_DRIFT * dt;
    for (const wave of this.waves) {
      wave.x = (wave.x + wdx + w) % w;
      wave.y = (wave.y + wdy + h) % h;
    }

    // The screen is a steering wheel: the finger's direction from the screen
    // center IS the desired compass heading — not a place to sail to. On
    // release there is no retained target; the current heading carries on.
    let tt: -1 | 0 | 1 = 0;
    if (this.touch.steerPt) {
      const dx = this.touch.steerPt.x - w / 2;
      const dy = this.touch.steerPt.y - h / 2;
      if (Math.hypot(dx, dy) > WHEEL_DEADZONE) tt = turnToward(Math.atan2(dy, dx), this.player.heading);
    }
    const touchFire = this.touch.consumeFire(); // one true per tap (edge-triggered)
    this.input.setVirtual(tt === -1, tt === 1, touchFire, this.touch.dive);

    let turn: Turn = 0;
    if (this.input.isDown('ArrowLeft') || this.input.isDown('KeyA')) turn = -1;
    if (this.input.isDown('ArrowRight') || this.input.isDown('KeyD')) turn = 1;

    // Player submarine: hold ↓/S to dive while the charge lasts (see DIVE).
    if (this.player.type === 'submarine' && this.player.alive) {
      const wantDive =
        !this.over &&
        (this.input.isDown('ArrowDown') || this.input.isDown('KeyS')) &&
        this.diveCharge > 0;
      this.player.depth = Math.max(
        0,
        Math.min(1, this.player.depth + ((wantDive ? 1 : -1) * dt) / DIVE.anim),
      );
      if (this.player.depth > 0.15 && wantDive) this.diveCharge = Math.max(0, this.diveCharge - dt);
      else if (this.player.depth === 0)
        this.diveCharge = Math.min(DIVE.max, this.diveCharge + DIVE.refill * dt);
    }
    const playerHidden = this.player.depth > DIVE.hidden;

    // Power-up countdowns and the Ship fields they drive (boost/range/damage)
    // must be current before movement and firing read them this tick.
    this.tickBuff(this.player, this.playerBuff, dt);
    this.tickBuff(this.enemy, this.enemyBuff, dt);

    // Braking: on any hull but the submarine (which already holds ↓/S for
    // diving), the same key bleeds off forward way while held (see the
    // BRAKE_RAMP easing in Ship.update).
    const playerBraking =
      this.player.type !== 'submarine' &&
      !this.over &&
      (this.input.isDown('ArrowDown') || this.input.isDown('KeyS'));

    // Submarines run on engines — the wind never touches them.
    const psf = this.player.type === 'submarine' ? 1 : this.wind.speedFactor(this.player.heading);
    this.player.update(dt, turn, w, h, psf, playerBraking);
    this.enemy.update(
      dt,
      // The enemy captain can't see (or chase) a submerged player.
      this.over || playerHidden ? 0 : decideTurn(this.enemy, this.player, aiOpts),
      w,
      h,
      this.wind.speedFactor(this.enemy.heading),
    );

    this.updateRam(dt, w, h);

    if (!this.over) {
      // Advance any manual reload in progress; refill the magazine when done.
      if (this.reloadTimer > 0) {
        this.reloadTimer = Math.max(0, this.reloadTimer - dt);
        if (this.reloadTimer === 0) this.ammo = this.ammoCap;
      }

      // Firing is edge-triggered: one broadside per press/tap, so a held key
      // no longer dumps the whole magazine in a few frames. Rapid taps still
      // fire back-to-back with no enforced gap.
      const firePressed = this.input.wasPressed('Space') || touchFire;
      this.updatePlayerFire(firePressed);
      if (!playerHidden) this.updateEnemyFire(aiOpts, diff.reload);

      this.updatePickups(dt);
    }

    for (const ball of this.cannonballs) {
      ball.update(dt, w, h);
      const target = ball.owner === this.player ? this.enemy : this.player;
      if (target === this.player && this.player.depth > DIVE.immune) continue; // passes over
      if (!ball.spent && target.alive && target.containsPointWrapped(ball.x, ball.y, w, h)) {
        ball.spent = true;
        this.explosions.push(new Explosion(ball.x, ball.y));
        if (target.shield > 0) {
          target.shield--; // a shield charge soaks the hit
        } else {
          target.takeHit(ball.damage);
          this.onHit?.(target === this.player);
        }
      }
    }
    this.cannonballs = this.cannonballs.filter((b) => !b.spent);

    for (const ex of this.explosions) ex.update(dt);
    this.explosions = this.explosions.filter((ex) => !ex.done);
  }

  /** Ship-vs-ship contact — same bow-ram rules as multiplayer (see RAM in
   *  ship.ts): hulls shove apart, and whoever's bow is driving in deals the
   *  ram damage. Glancing side scrapes just separate. */
  private updateRam(dt: number, w: number, h: number) {
    this.ramCd = Math.max(0, this.ramCd - dt);

    const A = this.player;
    const B = this.enemy;
    if (!A.alive || !B.alive) return;
    if (A.depth > DIVE.immune || B.depth > DIVE.immune) return; // sub passes under

    // Nearest-image delta so ramming works across the wrap seam too.
    const dx = wrapDelta(B.x - A.x, w);
    const dy = wrapDelta(B.y - A.y, h);
    const dist = Math.hypot(dx, dy) || 0.001;
    const contact = A.length * 0.42 + B.length * 0.42;
    if (dist >= contact) return;

    // Shove the hulls apart so they don't interpenetrate.
    const nx = dx / dist;
    const ny = dy / dist;
    const push = (contact - dist) * 0.5;
    A.x -= nx * push;
    A.y -= ny * push;
    B.x += nx * push;
    B.y += ny * push;

    if (this.ramCd > 0) return; // just separated recently

    // Whose bow (the whole curved front) is driving into the other? A is the
    // player, B the enemy — so youWereHit is true whenever the player's hull
    // takes the ram (bow-to-bow, or being speared).
    const aBow = Math.cos(A.heading) * nx + Math.sin(A.heading) * ny >= RAM.bowCos;
    const bBow = Math.cos(B.heading) * -nx + Math.sin(B.heading) * -ny >= RAM.bowCos;
    let youWereHit: boolean;
    if (aBow && bBow) {
      // Bow-to-bow: both hulls take the full ram, no extra return damage.
      A.takeHit(RAM.dmg);
      B.takeHit(RAM.dmg);
      youWereHit = true;
    } else if (aBow) {
      B.takeHit(RAM.dmg);
      A.takeHit(RAM.selfDmg);
      youWereHit = false; // you did the ramming
    } else if (bBow) {
      A.takeHit(RAM.dmg);
      B.takeHit(RAM.selfDmg);
      youWereHit = true;
    } else {
      return; // glancing scrape — no damage, no cooldown
    }

    this.ramCd = RAM.cd;
    this.explosions.push(new Explosion(A.x + nx * (dist / 2), A.y + ny * (dist / 2)));
    this.onHit?.(youWereHit);
  }

  /** Player submarine: a single straight-ahead bow torpedo. Range doesn't
   *  apply — torpedoes already run the length of the map — but Damage does.
   *  `reload` is 0 for a normal magazine-gated shot (the magazine itself
   *  gates the next one) and MG_RELOAD_SUB during Rapid Fire, which bypasses
   *  the magazine entirely and so needs its own cadence to not fire every
   *  single frame. */
  private fireTorpedo(reload: number) {
    const p = this.player;
    this.cannonballs.push(
      new Cannonball(
        p.x + Math.cos(p.heading) * (p.length / 2 + 4),
        p.y + Math.sin(p.heading) * (p.length / 2 + 4),
        p.heading,
        p,
        true,
        1,
        p.damageFactor,
      ),
    );
    p.reload = reload;
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
      this.cannonballs.push(
        new Cannonball(
          shooter.x + fx * along + sx * reach,
          shooter.y + fy * along + sy * reach,
          dir,
          shooter,
          false,
          shooter.rangeFactor,
          shooter.damageFactor,
        ),
      );
    }
    shooter.reload = reload;
  }

  private fireBroadside(shooter: Ship, reload: number) {
    this.fireSide(shooter, 1, reload); // guns live on the starboard rail
  }

  /** Double-broadside power-up: fire both sides at once. */
  private fireBoth(shooter: Ship, reload: number) {
    this.fireSide(shooter, 1, reload);
    this.fireSide(shooter, -1, reload);
  }

  /** Player fire: Rapid Fire bypasses the magazine while it runs (auto-fires
   *  on its own cadence); otherwise a fresh trigger press spends one magazine
   *  volley — both sides at once during 2× Fire. */
  private updatePlayerFire(firePressed: boolean) {
    const p = this.player;
    const b = this.playerBuff;

    if (b.mgT > 0) {
      if (p.reload <= 0) {
        if (p.type === 'submarine') this.fireTorpedo(MG_RELOAD_SUB);
        else this.fireBroadside(p, MG_RELOAD);
        this.onCannonFire?.();
      }
      return;
    }

    // Running dry starts the reload on its own — the same MAG_RELOAD wait,
    // just without having to ask for it. R still tops up early at any time,
    // which costs the full reload for whatever's left in the magazine.
    const wantReload = this.input.wasPressed('KeyR') || this.ammo < p.guns;
    if (this.reloadTimer === 0 && this.ammo < this.ammoCap && wantReload && !b.mgArmed) {
      this.reloadTimer = MAG_RELOAD;
    }

    // A freshly grabbed Rapid Fire arms on the next press and bypasses ammo.
    if (b.mgArmed) {
      if (!firePressed) return;
      b.mgArmed = false;
      b.mgT = MG_DURATION;
      if (p.type === 'submarine') this.fireTorpedo(MG_RELOAD_SUB);
      else this.fireBroadside(p, MG_RELOAD);
      this.onCannonFire?.();
      haptic(15);
      return;
    }

    // Fire whenever a full broadside's worth of ammo is loaded — no cadence,
    // so taps can be as fast as you like. Submarines can launch torpedoes
    // surfaced or submerged.
    if (!firePressed || this.reloadTimer > 0 || this.ammo < p.guns) return;
    if (p.type === 'submarine') this.fireTorpedo(0);
    else if (b.doubleT > 0) this.fireBoth(p, 0);
    else this.fireBroadside(p, 0);
    this.ammo -= p.guns;
    this.onCannonFire?.();
    haptic(15);
  }

  /** Enemy fire: the same Rapid Fire / 2× Fire behavior, on the AI's own
   *  cadence instead of a magazine (the enemy never carries one). */
  private updateEnemyFire(aiOpts: AiOptions, reloadTime: number) {
    const e = this.enemy;
    const b = this.enemyBuff;

    if (b.mgT > 0) {
      if (e.reload <= 0) this.fireBroadside(e, MG_RELOAD);
      return;
    }
    if (!wantsToFire(e, this.player, aiOpts) || e.reload > 0) return;
    if (b.mgArmed) {
      b.mgArmed = false;
      b.mgT = MG_DURATION;
      this.fireBroadside(e, MG_RELOAD);
    } else if (b.doubleT > 0) {
      this.fireBoth(e, reloadTime);
    } else {
      this.fireBroadside(e, reloadTime);
    }
  }

  /** Advance one hull's power-up countdowns and sync the Ship fields that
   *  movement/firing/rendering read (mirrors the buff model in multiplayer.ts). */
  private tickBuff(ship: Ship, buff: Buff, dt: number) {
    buff.doubleT = Math.max(0, buff.doubleT - dt);
    buff.speedT = Math.max(0, buff.speedT - dt);
    buff.mgT = Math.max(0, buff.mgT - dt);
    buff.rangeT = Math.max(0, buff.rangeT - dt);
    buff.damageT = Math.max(0, buff.damageT - dt);
    buff.shieldT = Math.max(0, buff.shieldT - dt);
    if (buff.shieldT <= 0) ship.shield = 0;
    ship.boostFactor = buff.speedT > 0 ? SPEED_MULT : 1;
    ship.rangeFactor = buff.rangeT > 0 ? RANGE_MULT : 1;
    ship.damageFactor = buff.damageT > 0 ? DAMAGE_MULT : 1;
  }

  // ── Power-ups (host-equivalent logic, single player) ───────────────────────

  private updatePickups(dt: number) {
    // Expire uncollected pickups so they relocate and the water stays fresh.
    for (const p of this.pickups) p.ttl -= dt;
    this.pickups = this.pickups.filter((p) => p.ttl > 0);

    for (const type of PICKUP_ORDER) {
      this.pickupTimers[type] -= dt;
      if (this.pickupTimers[type] > 0) continue;
      const [lo, hi] = PICKUP_SPAWN[type];
      this.pickupTimers[type] = lo + Math.random() * (hi - lo);
      if (this.pickups.length >= MAX_PICKUPS) continue;
      const spot = this.pickPickupSpot();
      if (spot) this.pickups.push({ id: this.pickupId++, type, x: spot.x, y: spot.y, ttl: PICKUP_TTL });
    }

    this.collectPickup(this.player, this.playerBuff, true);
    this.collectPickup(this.enemy, this.enemyBuff, false);
    this.pickups = this.pickups.filter((p) => p.ttl > 0);
  }

  /** A random open-water spot, spread out from any pickup already afloat. */
  private pickPickupSpot(): { x: number; y: number } | null {
    const w = this.viewW;
    const h = this.viewH;
    for (let attempt = 0; attempt < 12; attempt++) {
      const x = 60 + Math.random() * (w - 120);
      const y = 60 + Math.random() * (h - 120);
      if (this.pickups.some((q) => Math.hypot(q.x - x, q.y - y) < 90)) continue;
      return { x, y };
    }
    return null;
  }

  private collectPickup(ship: Ship, buff: Buff, isPlayer: boolean) {
    if (!ship.alive || ship.depth > 0.3) return; // must surface to grab bounties
    for (const p of this.pickups) {
      if (p.ttl <= 0) continue;
      if (Math.hypot(ship.x - p.x, ship.y - p.y) < PICKUP_R + ship.width * 0.7) {
        this.applyPickup(ship, buff, p.type);
        p.ttl = 0;
        if (isPlayer) this.onPickup?.(p.type);
        return;
      }
    }
  }

  private applyPickup(ship: Ship, buff: Buff, type: PickupType) {
    switch (type) {
      case 'health':
        ship.health = Math.min(ship.maxHealth, ship.health + 1);
        break;
      case 'shield':
        ship.shield = SHIELD_HITS;
        buff.shieldT = SHIELD_DURATION;
        break;
      case 'speed':
        buff.speedT = SPEED_DURATION;
        break;
      case 'double':
        buff.doubleT = DOUBLE_DURATION;
        break;
      case 'machinegun':
        buff.mgArmed = true;
        break;
      case 'range':
        buff.rangeT = RANGE_DURATION;
        break;
      case 'damage':
        buff.damageT = DAMAGE_DURATION;
        break;
    }
  }

  private render() {
    // High-DPI: draw in CSS pixels on a device-pixel backing store.
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawSea();
    if (this.phase === 'idle') return;

    const ctx = this.ctx;
    this.drawPickups();
    for (const ball of this.cannonballs) ball.draw(ctx);
    if (this.player.sinkProgress < 1) this.drawShipBuffs(this.player, this.playerBuff);
    if (this.enemy.sinkProgress < 1) this.drawShipBuffs(this.enemy, this.enemyBuff);
    this.player.gunHighlight = this.playerBuff.doubleT > 0; // gold guns during double
    this.enemy.gunHighlight = this.enemyBuff.doubleT > 0;
    this.player.drawWrapped(ctx, this.viewW, this.viewH);
    this.enemy.drawWrapped(ctx, this.viewW, this.viewH);

    // Player submarine: cyan dive-charge bar under the hull.
    if (this.player.type === 'submarine' && this.player.alive) {
      const w2 = 40;
      const y = this.player.y + this.player.length * 0.62;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.fillRect(this.player.x - w2 / 2 - 1, y - 1, w2 + 2, 5);
      ctx.fillStyle = '#4fd8ef';
      ctx.fillRect(this.player.x - w2 / 2, y, (w2 * this.diveCharge) / DIVE.max, 3);
    }
    if (this.player.alive && !this.over) this.drawAmmo();
    for (const ex of this.explosions) ex.draw(ctx);

    // Mobile assist: flag shots that are about to reach you.
    if (this.isTouchDevice && !this.over && this.player.alive) {
      for (const bearing of incomingThreats(this.player, this.cannonballs, this.viewW, this.viewH)) {
        drawThreatArc(ctx, this.player.x, this.player.y, this.player.length * 0.85, bearing);
      }
    }

    // Health rides just above each hull (the same spot multiplayer uses), so
    // your ship carries both readouts — health above, ammo below.
    this.drawShipHealth(this.player, `You · ${this.player.type}`);
    this.drawBuffIcons(this.player, this.playerBuff);
    this.drawShipHealth(
      this.enemy,
      `Enemy · ${this.enemy.type} · ${DIFFICULTIES[this.difficulty].label}`,
    );
    this.drawBuffIcons(this.enemy, this.enemyBuff);
    if (this.survivorKills !== null) this.drawKillCounter();
    this.drawWindIndicator();

    if (this.isTouchDevice && !this.over) {
      this.touch.draw(ctx, this.viewW, this.viewH, this.player?.type === 'submarine');
    }
  }

  /** Magazine HUD under the player: one pip per bullet (bright = loaded), a
   *  reload progress bar while reloading, and a prompt to press R when spent. */
  private drawAmmo() {
    const ctx = this.ctx;
    const p = this.player;
    // Sit below the hull — and below the submarine's dive bar when present.
    const y = p.y + p.length * (p.type === 'submarine' ? 0.9 : 0.62);
    const pipW = 7;
    const pipH = 5;
    const gap = 3;
    const totalW = this.ammoCap * (pipW + gap) - gap;
    const x0 = p.x - totalW / 2;

    if (this.reloadTimer > 0) {
      // Reloading: a shrinking-to-full amber bar spanning the pip row.
      const prog = 1 - this.reloadTimer / MAG_RELOAD;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.fillRect(x0 - 1, y - 1, totalW + 2, pipH + 2);
      ctx.fillStyle = '#ffb300';
      ctx.fillRect(x0, y, totalW * prog, pipH);
    } else {
      for (let i = 0; i < this.ammoCap; i++) {
        ctx.fillStyle = i < this.ammo ? '#ffd75e' : 'rgba(0, 0, 0, 0.45)';
        ctx.fillRect(x0 + i * (pipW + gap), y, pipW, pipH);
      }
    }

  }

  /** Floating power-up bounties: a colored disc with an icon, bobbing gently,
   *  labeled so it's clear what each one grants. Matches the multiplayer look. */
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

      ctx.font = 'bold 10px system-ui, sans-serif';
      ctx.textBaseline = 'top';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.65)';
      ctx.strokeText(meta.label, p.x, yy + PICKUP_R + 3);
      ctx.fillStyle = '#fff';
      ctx.fillText(meta.label, p.x, yy + PICKUP_R + 3);
    }
  }

  /** Auras drawn beneath a hull for its active power-ups: a speed streak, a
   *  pulsing shield ring. */
  private drawShipBuffs(ship: Ship, buff: Buff) {
    const ctx = this.ctx;

    if (buff.speedT > 0) {
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

    if (ship.shield > 0) {
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

  /** Short readable tags above the health bar showing a hull's active
   *  power-ups (sits above the "You · type" / "Enemy · ..." caption). */
  private drawBuffIcons(ship: Ship, buff: Buff) {
    if (ship.sinkProgress >= 1) return;
    const tags: string[] = [];
    if (buff.speedT > 0) tags.push('2×SPD');
    if (buff.doubleT > 0) tags.push('DBL');
    if (buff.mgT > 0) tags.push('RAPID');
    if (buff.rangeT > 0) tags.push('2×RNG');
    if (buff.damageT > 0) tags.push('2×DMG');
    if (ship.shield > 0) tags.push(`SHLD${ship.shield}`);
    if (!tags.length) return;

    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 1 - ship.sinkProgress;
    ctx.font = 'bold 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const text = tags.join(' ');
    const y = ship.y - ship.length * 0.62 - 18; // clears the caption drawn by drawShipHealth
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.strokeText(text, ship.x, y);
    ctx.fillStyle = '#ffe07a';
    ctx.fillText(text, ship.x, y);
    ctx.restore();
  }

  private drawSea() {
    const ctx = this.ctx;
    const w = this.viewW;
    const h = this.viewH;

    ctx.fillStyle = '#2e6da6';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 1.5;
    for (const wave of this.waves) {
      ctx.beginPath();
      ctx.arc(wave.x, wave.y, wave.r, Math.PI * 0.15, Math.PI * 0.85);
      ctx.stroke();
    }
  }

  /** Segmented health bar floating just above the hull, colored by how hurt
   *  the ship is (green → amber → red), with a caption above it. Matches the
   *  multiplayer look so both modes read the same. */
  private drawShipHealth(ship: Ship, label: string) {
    if (ship.sinkProgress >= 1) return;
    const ctx = this.ctx;
    const n = ship.maxHealth;
    const segW = 8;
    const segH = 5;
    const gap = 2;
    const totalW = n * (segW + gap) - gap;
    const x0 = ship.x - totalW / 2;
    const y = ship.y - ship.length * 0.62;
    const frac = ship.health / ship.maxHealth;
    const col = frac > 0.5 ? '#5bd15f' : frac > 0.25 ? '#e6b422' : '#e8503a';

    ctx.save();
    ctx.globalAlpha = 1 - ship.sinkProgress;

    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.fillText(label, ship.x, y - 4);

    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(x0 - 1.5, y - 1.5, totalW + 3, segH + 3);
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
      ctx.fillRect(x0 + i * (segW + gap), y, segW, segH);
      const f = Math.max(0, Math.min(1, ship.health - i)); // partial-fill the edge pip
      if (f > 0) {
        ctx.fillStyle = col;
        ctx.fillRect(x0 + i * (segW + gap), y, segW * f, segH);
      }
    }
    ctx.restore();
  }

  private drawKillCounter() {
    const ctx = this.ctx;
    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffd75e';
    ctx.fillText(`⚓ ${this.survivorKills} sunk`, this.viewW - 16, 22);
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
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    if (this.player.type === 'submarine') {
      ctx.fillText('Engine', cx, cy + r + 32); // subs ignore the wind
    } else {
      const pct = Math.round(this.wind.speedFactor(this.player.heading) * 100);
      ctx.fillText(`Sails ${pct}%`, cx, cy + r + 32);
    }
  }
}
