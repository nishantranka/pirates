import { decideTurn, wantsToFire } from './ai';
import { Cannonball } from './cannonball';
import { Explosion } from './explosion';
import type { Input } from './input';
import { DIVE, gunOffsets, muzzleReach, RAM, SAIL_TYPES, Ship, wrapDelta, YOU_COLOR, type ShipTypeName, type Turn } from './ship';
import { drawTouchBtn, hitBtn, layoutTouchButtons, touchCapable, type TouchButtons } from './touchui';
import { Wind } from './wind';

const MAX_DT = 0.05;
const WAVE_DRIFT = 14;
const PLAYER_RELOAD = 1.4;

export const DIFFICULTIES = {
  easy: { label: 'Easy', reload: 2.2, leadShots: false, windAware: false },
  medium: { label: 'Medium', reload: 1.8, leadShots: true, windAware: false },
  hard: { label: 'Hard', reload: 1.4, leadShots: true, windAware: true },
} as const;

export type DifficultyName = keyof typeof DIFFICULTIES;

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

  /** Set by main.ts; called once when the battle ends (won = enemy sunk). */
  onGameOver: ((won: boolean) => void) | null = null;
  /** Called when the player fires a broadside. */
  onCannonFire: (() => void) | null = null;
  /** Called each time a hit lands; the flag is true when the player was the one
   *  hit (so the UI can play a heavier "you got hit" cue) and false when the
   *  player dealt it. */
  onHit: ((youWereHit: boolean) => void) | null = null;
  /** When non-null (survivor mode), renders the kill count in the HUD. */
  survivorKills: number | null = null;
  /** While true another renderer (multiplayer) owns the canvas; this loop idles. */
  suspended = false;

  // Not readonly: some WebViews under-report touch capability, so the first
  // real touch event anywhere upgrades this at runtime.
  private isTouchDevice = touchCapable();
  private btns!: TouchButtons;

  constructor(ctx: CanvasRenderingContext2D, input: Input) {
    this.ctx = ctx;
    this.input = input;

    const w = this.viewW;
    const h = this.viewH;
    this.updateBtnRects(w, h);

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

  private updateBtnRects(w: number, h: number) {
    this.btns = layoutTouchButtons(w, h);
  }

  private onTouch = (e: TouchEvent) => {
    this.isTouchDevice = true;
    if (this.phase !== 'battle') return;
    const rect = this.ctx.canvas.getBoundingClientRect();
    const scaleX = this.viewW / rect.width;
    const scaleY = this.viewH / rect.height;
    let left = false;
    let right = false;
    let fire = false;
    let dive = false;
    for (const t of Array.from(e.touches)) {
      const tx = (t.clientX - rect.left) * scaleX;
      const ty = (t.clientY - rect.top) * scaleY;
      if (hitBtn(this.btns.left, tx, ty)) left = true;
      if (hitBtn(this.btns.right, tx, ty)) right = true;
      if (hitBtn(this.btns.fire, tx, ty)) fire = true;
      if (hitBtn(this.btns.dive, tx, ty)) dive = true;
    }
    this.input.setVirtual(left, right, fire, dive && this.player?.type === 'submarine');
  };

  startBattle(playerType: ShipTypeName, enemyType: ShipTypeName | 'random', difficulty: DifficultyName) {
    const w = this.viewW;
    const h = this.viewH;
    let resolvedEnemy = enemyType;
    if (resolvedEnemy === 'random') {
      resolvedEnemy = SAIL_TYPES[Math.floor(Math.random() * SAIL_TYPES.length)];
    }

    this.difficulty = difficulty;
    this.player = new Ship(w * 0.3, h * 0.6, -Math.PI / 4, PLAYER_COLOR, playerType);
    this.enemy = new Ship(w * 0.7, h * 0.3, Math.PI * 0.75, ENEMY_COLOR, resolvedEnemy);
    this.diveCharge = DIVE.max;
    this.ramCd = 0;
    this.cannonballs = [];
    this.explosions = [];
    this.wind = new Wind();
    this.gameOverFired = false;
    this.survivorKills = null;
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
    this.ramCd = 0;
    this.cannonballs = [];
    this.explosions = [];
    this.gameOverFired = false;
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
    this.updateBtnRects(w, h);
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

    // Submarines run on engines — the wind never touches them.
    const psf = this.player.type === 'submarine' ? 1 : this.wind.speedFactor(this.player.heading);
    this.player.update(dt, turn, w, h, psf);
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
      // Submarines can launch torpedoes surfaced or submerged.
      if (this.input.isDown('Space') && this.player.reload <= 0) {
        if (this.player.type === 'submarine') this.fireTorpedo();
        else this.fireBroadside(this.player, PLAYER_RELOAD);
        this.onCannonFire?.();
      }
      if (!playerHidden && wantsToFire(this.enemy, this.player, aiOpts) && this.enemy.reload <= 0) {
        this.fireBroadside(this.enemy, diff.reload);
      }
    }

    for (const ball of this.cannonballs) {
      ball.update(dt, w, h);
      const target = ball.owner === this.player ? this.enemy : this.player;
      if (target === this.player && this.player.depth > DIVE.immune) continue; // passes over
      if (!ball.spent && target.alive && target.containsPointWrapped(ball.x, ball.y, w, h)) {
        ball.spent = true;
        target.takeHit(ball.damage);
        this.explosions.push(new Explosion(ball.x, ball.y));
        this.onHit?.(target === this.player);
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

  /** Player submarine: a single straight-ahead bow torpedo. */
  private fireTorpedo() {
    const p = this.player;
    this.cannonballs.push(
      new Cannonball(
        p.x + Math.cos(p.heading) * (p.length / 2 + 4),
        p.y + Math.sin(p.heading) * (p.length / 2 + 4),
        p.heading,
        p,
        true,
      ),
    );
    p.reload = PLAYER_RELOAD;
  }

  private fireBroadside(shooter: Ship, reload: number) {
    // Guns live on the starboard rail — every broadside fires that way.
    const dir = shooter.heading + Math.PI / 2;

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
        ),
      );
    }
    shooter.reload = reload;
  }

  private render() {
    // High-DPI: draw in CSS pixels on a device-pixel backing store.
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawSea();
    if (this.phase === 'idle') return;

    const ctx = this.ctx;
    for (const ball of this.cannonballs) ball.draw(ctx);
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
    for (const ex of this.explosions) ex.draw(ctx);

    this.drawHealthRow(`You (${this.player.type})`, this.player, 0);
    this.drawHealthRow(
      `Enemy (${this.enemy.type} · ${DIFFICULTIES[this.difficulty].label})`,
      this.enemy,
      1,
    );
    if (this.survivorKills !== null) this.drawKillCounter();
    this.drawWindIndicator();

    if (this.isTouchDevice && !this.over) this.drawTouchButtons();
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

  private drawTouchButtons() {
    const ctx = this.ctx;
    drawTouchBtn(ctx, this.btns.left, '←', this.input.isDown('ArrowLeft'));
    drawTouchBtn(ctx, this.btns.right, '→', this.input.isDown('ArrowRight'));
    drawTouchBtn(ctx, this.btns.fire, '🔥', this.input.isDown('Space'));
    if (this.player?.type === 'submarine') {
      drawTouchBtn(ctx, this.btns.dive, '🤿', this.input.isDown('ArrowDown'));
    }
  }

  private drawHealthRow(label: string, ship: Ship, row: number) {
    const ctx = this.ctx;
    const segW = 14;
    const segH = 10;
    const gap = 3;
    const margin = 16;

    const y = margin + row * (segH + 12);
    const totalW = ship.maxHealth * (segW + gap) - gap;
    const x0 = this.viewW - margin - totalW;

    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.fillText(label, x0 - 10, y + segH / 2);

    for (let i = 0; i < ship.maxHealth; i++) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
      ctx.fillRect(x0 + i * (segW + gap), y, segW, segH);
      const f = Math.max(0, Math.min(1, ship.health - i)); // partial-fill the edge pip
      if (f > 0) {
        ctx.fillStyle = '#4caf50';
        ctx.fillRect(x0 + i * (segW + gap), y, segW * f, segH);
      }
    }
  }

  private drawKillCounter() {
    const ctx = this.ctx;
    const margin = 16;
    const segH = 10;
    const rowH = segH + 12;
    // Sits below the two health rows.
    const y = margin + 2 * rowH + 4;

    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffd75e';
    ctx.fillText(`⚓ ${this.survivorKills} sunk`, this.viewW - margin, y);
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
