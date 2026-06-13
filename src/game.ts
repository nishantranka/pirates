import { decideTurn, wantsToFire } from './ai';
import { Cannonball } from './cannonball';
import { Explosion } from './explosion';
import type { Input } from './input';
import { Ship, SHIP_TYPES, type ShipTypeName, type Turn } from './ship';
import { Wind } from './wind';

const MAX_DT = 0.05; // s; clamp so tab-switch pauses don't teleport ships
const WAVE_DRIFT = 14; // px/s; background waves ride the wind
const PLAYER_RELOAD = 1.4; // s between broadsides

// Difficulty changes the enemy captain's skill, never damage numbers.
const DIFFICULTIES = {
  easy: { label: 'Easy', reload: 2.2, leadShots: false, windAware: false },
  medium: { label: 'Medium', reload: 1.8, leadShots: true, windAware: false },
  hard: { label: 'Hard', reload: 1.4, leadShots: true, windAware: true },
} as const;

type DifficultyName = keyof typeof DIFFICULTIES;

const DIFFICULTY_KEYS: Record<string, DifficultyName> = {
  Digit1: 'easy',
  Digit2: 'medium',
  Digit3: 'hard',
};

const DIFFICULTY_BLURBS: Record<DifficultyName, string> = {
  easy: 'slow reload · aims at where you are',
  medium: 'quicker reload · leads your movement',
  hard: 'reloads as fast as you · leads shots · sails the wind',
};

const PLAYER_COLOR = '#8b5a2b';
const ENEMY_COLOR = '#7a1f1f';

const SELECT_KEYS: Record<string, ShipTypeName> = {
  Digit1: 'small',
  Digit2: 'medium',
  Digit3: 'large',
};

const SPEED_LABELS: Record<ShipTypeName, string> = {
  small: 'fast',
  medium: 'steady',
  large: 'slow',
};

interface Wave {
  x: number;
  y: number;
  r: number;
}

export class Game {
  private ctx: CanvasRenderingContext2D;
  private input: Input;
  private phase: 'select' | 'enemySelect' | 'difficultySelect' | 'battle' = 'select';
  private pendingPlayerType: ShipTypeName = 'small';
  private pendingEnemyType: ShipTypeName | 'random' = 'random';
  private difficulty: DifficultyName = 'easy';
  private player!: Ship;
  private enemy!: Ship;
  private cannonballs: Cannonball[] = [];
  private explosions: Explosion[] = [];
  private waves: Wave[] = [];
  private wind = new Wind();
  private lastTime = 0;

  constructor(ctx: CanvasRenderingContext2D, input: Input) {
    this.ctx = ctx;
    this.input = input;

    const { width: w, height: h } = ctx.canvas;
    for (let i = 0; i < 40; i++) {
      this.waves.push({
        x: Math.random() * w,
        y: Math.random() * h,
        r: 6 + Math.random() * 10,
      });
    }
  }

  private startBattle() {
    const { width: w, height: h } = this.ctx.canvas;
    let enemyType = this.pendingEnemyType;
    if (enemyType === 'random') {
      const types = Object.keys(SHIP_TYPES) as ShipTypeName[];
      enemyType = types[Math.floor(Math.random() * types.length)];
    }

    this.player = new Ship(w * 0.3, h * 0.6, -Math.PI / 4, PLAYER_COLOR, this.pendingPlayerType);
    this.enemy = new Ship(w * 0.7, h * 0.3, Math.PI * 0.75, ENEMY_COLOR, enemyType);
    this.cannonballs = [];
    this.explosions = [];
    this.wind = new Wind();
    this.phase = 'battle';
  }

  private get over(): boolean {
    return !this.player.alive || !this.enemy.alive;
  }

  start() {
    this.lastTime = performance.now();
    requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    const dt = Math.min((now - this.lastTime) / 1000, MAX_DT);
    this.lastTime = now;
    this.update(dt);
    this.input.clearPressed();
    this.render();
    requestAnimationFrame(this.frame);
  };

  private update(dt: number) {
    if (this.phase === 'select') {
      for (const [code, type] of Object.entries(SELECT_KEYS)) {
        if (this.input.wasPressed(code)) {
          this.pendingPlayerType = type;
          this.phase = 'enemySelect';
          break;
        }
      }
      return;
    }

    if (this.phase === 'enemySelect') {
      for (const [code, type] of Object.entries(SELECT_KEYS)) {
        if (this.input.wasPressed(code)) {
          this.pendingEnemyType = type;
          this.phase = 'difficultySelect';
          break;
        }
      }
      if (this.input.wasPressed('Digit4')) {
        this.pendingEnemyType = 'random';
        this.phase = 'difficultySelect';
      }
      return;
    }

    if (this.phase === 'difficultySelect') {
      for (const [code, name] of Object.entries(DIFFICULTY_KEYS)) {
        if (this.input.wasPressed(code)) {
          this.difficulty = name;
          this.startBattle();
          break;
        }
      }
      return;
    }

    const { width: w, height: h } = this.ctx.canvas;

    if (this.over && this.input.wasPressed('KeyR')) {
      this.phase = 'select';
      return;
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

    this.player.update(dt, turn, w, h, this.wind.speedFactor(this.player.heading));
    this.enemy.update(
      dt,
      this.over ? 0 : decideTurn(this.enemy, this.player, aiOpts),
      w,
      h,
      this.wind.speedFactor(this.enemy.heading),
    );

    if (!this.over) {
      if (this.input.isDown('Space') && this.player.reload <= 0) {
        this.fireBroadside(this.player, this.enemy, PLAYER_RELOAD);
      }
      if (wantsToFire(this.enemy, this.player, aiOpts) && this.enemy.reload <= 0) {
        this.fireBroadside(this.enemy, this.player, diff.reload);
      }
    }

    for (const ball of this.cannonballs) {
      ball.update(dt);
      const target = ball.owner === this.player ? this.enemy : this.player;
      if (!ball.spent && target.alive && target.containsPoint(ball.x, ball.y)) {
        ball.spent = true;
        target.takeHit();
        this.explosions.push(new Explosion(ball.x, ball.y));
      }
    }
    this.cannonballs = this.cannonballs.filter((b) => !b.spent);

    for (const ex of this.explosions) ex.update(dt);
    this.explosions = this.explosions.filter((ex) => !ex.done);
  }

  /** Fire a volley from whichever side of the shooter faces the target. */
  private fireBroadside(shooter: Ship, target: Ship, reload: number) {
    const bearing = Math.atan2(target.y - shooter.y, target.x - shooter.x);
    const side = Math.sin(bearing - shooter.heading) >= 0 ? 1 : -1;
    const dir = shooter.heading + (side * Math.PI) / 2;

    const fx = Math.cos(shooter.heading);
    const fy = Math.sin(shooter.heading);
    const sx = Math.cos(dir);
    const sy = Math.sin(dir);

    for (let i = 0; i < shooter.guns; i++) {
      const along = (i / (shooter.guns - 1) - 0.5) * (shooter.length / 2);
      this.cannonballs.push(
        new Cannonball(
          shooter.x + fx * along + sx * (shooter.width / 2),
          shooter.y + fy * along + sy * (shooter.width / 2),
          dir,
          shooter,
        ),
      );
    }
    shooter.reload = reload;
  }

  private render() {
    this.drawSea();
    if (this.phase === 'select') {
      this.drawShipPicker('Pirates: Naval Combat', 'Choose your ship', PLAYER_COLOR, false);
      return;
    }
    if (this.phase === 'enemySelect') {
      this.drawShipPicker('Choose the enemy ship', 'Who do you want to face?', ENEMY_COLOR, true);
      return;
    }
    if (this.phase === 'difficultySelect') {
      this.drawDifficultySelect();
      return;
    }

    const ctx = this.ctx;
    for (const ball of this.cannonballs) ball.draw(ctx);
    this.player.draw(ctx);
    this.enemy.draw(ctx);
    for (const ex of this.explosions) ex.draw(ctx);

    this.drawHealthRow(`You (${this.player.type})`, this.player, 0);
    this.drawHealthRow(
      `Enemy (${this.enemy.type} · ${DIFFICULTIES[this.difficulty].label})`,
      this.enemy,
      1,
    );
    this.drawWindIndicator();

    if (this.over) this.drawGameOver();
  }

  private drawSea() {
    const ctx = this.ctx;
    const { width: w, height: h } = ctx.canvas;

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

  private drawShipPicker(title: string, subtitle: string, hullColor: string, withRandom: boolean) {
    const ctx = this.ctx;
    const { width: w, height: h } = ctx.canvas;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 44px system-ui, sans-serif';
    ctx.fillText(title, w / 2, h * 0.18);
    ctx.font = '22px system-ui, sans-serif';
    ctx.fillText(subtitle, w / 2, h * 0.18 + 44);

    const types = Object.keys(SHIP_TYPES) as ShipTypeName[];
    const cards = types.length + (withRandom ? 1 : 0);
    const cardX = (i: number) => w / 2 + (i - (cards - 1) / 2) * 230;
    const y = h * 0.5;

    types.forEach((type, i) => {
      const stats = SHIP_TYPES[type];
      const x = cardX(i);

      new Ship(x, y, -Math.PI / 2, hullColor, type).draw(ctx);

      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.font = 'bold 20px system-ui, sans-serif';
      ctx.fillText(`${i + 1} — ${type[0].toUpperCase()}${type.slice(1)}`, x, y + 70);
      ctx.font = '15px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.fillText(`${stats.guns} guns · ${SPEED_LABELS[type]} · ${stats.maxHealth} hits to sink`, x, y + 94);
    });

    if (withRandom) {
      const x = cardX(types.length);
      ctx.strokeStyle = hullColor;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, 26, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = hullColor;
      ctx.font = 'bold 34px system-ui, sans-serif';
      ctx.fillText('?', x, y + 1);

      ctx.fillStyle = '#fff';
      ctx.font = 'bold 20px system-ui, sans-serif';
      ctx.fillText(`${types.length + 1} — Random`, x, y + 70);
      ctx.font = '15px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.fillText('any of the three', x, y + 94);
    }

    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.font = '17px system-ui, sans-serif';
    if (withRandom) {
      ctx.fillText('Press 1, 2, 3 to pick the enemy ship — or 4 to leave it to chance', w / 2, h * 0.82);
    } else {
      ctx.fillText('Press 1, 2 or 3 to choose your ship', w / 2, h * 0.82);
      ctx.fillText('Press left or right arrows to control the ship - press spacebar to fire', w / 2, h * 0.82 + 28);
    }
  }

  private drawDifficultySelect() {
    const ctx = this.ctx;
    const { width: w, height: h } = ctx.canvas;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 44px system-ui, sans-serif';
    ctx.fillText('Choose difficulty', w / 2, h * 0.18);
    ctx.font = '22px system-ui, sans-serif';
    ctx.fillText('How good is the enemy captain?', w / 2, h * 0.18 + 44);

    const names = Object.keys(DIFFICULTIES) as DifficultyName[];
    names.forEach((name, i) => {
      const y = h * 0.42 + i * 80;
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 26px system-ui, sans-serif';
      ctx.fillText(`${i + 1} — ${DIFFICULTIES[name].label}`, w / 2, y);
      ctx.font = '16px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.fillText(DIFFICULTY_BLURBS[name], w / 2, y + 28);
    });

    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.font = '17px system-ui, sans-serif';
    ctx.fillText('Press 1, 2 or 3 to set sail', w / 2, h * 0.85);
  }

  private drawHealthRow(label: string, ship: Ship, row: number) {
    const ctx = this.ctx;
    const segW = 14;
    const segH = 10;
    const gap = 3;
    const margin = 16;

    const y = margin + row * (segH + 12);
    const totalW = ship.maxHealth * (segW + gap) - gap;
    const x0 = ctx.canvas.width - margin - totalW;

    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.fillText(label, x0 - 10, y + segH / 2);

    for (let i = 0; i < ship.maxHealth; i++) {
      ctx.fillStyle = i < ship.health ? '#4caf50' : 'rgba(255, 255, 255, 0.25)';
      ctx.fillRect(x0 + i * (segW + gap), y, segW, segH);
    }
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
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    const pct = Math.round(this.wind.speedFactor(this.player.heading) * 100);
    ctx.fillText(`Sails ${pct}%`, cx, cy + r + 32);
  }

  private drawGameOver() {
    const ctx = this.ctx;
    const { width: w, height: h } = ctx.canvas;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.fillRect(0, 0, w, h);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 42px system-ui, sans-serif';
    ctx.fillText(this.enemy.alive ? 'Your ship was destroyed!' : 'Enemy ship destroyed!', w / 2, h / 2 - 20);
    ctx.font = '20px system-ui, sans-serif';
    ctx.fillText('Press R for a new battle', w / 2, h / 2 + 24);
  }
}
