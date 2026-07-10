import type { Ship } from './ship';

export const CANNONBALL_SPEED = 390; // px/s (1.5× base, matching the faster ships)
const MAX_RANGE = 320; // px before the ball splashes into the sea

// Submarine bow torpedoes: faster, longer-legged, harder-hitting single shot.
export const TORPEDO_SPEED = 460;
export const TORPEDO_RANGE = 430;
export const TORPEDO_DAMAGE = 1.6;

export class Cannonball {
  x: number;
  y: number;
  spent = false;
  readonly owner: Ship;
  readonly torpedo: boolean;

  readonly vx: number;
  readonly vy: number;
  private readonly speed: number;
  private readonly range: number;
  private readonly baseDamage: number;
  private traveled = 0;

  constructor(x: number, y: number, direction: number, owner: Ship, torpedo = false) {
    this.x = x;
    this.y = y;
    this.torpedo = torpedo;
    this.speed = torpedo ? TORPEDO_SPEED : CANNONBALL_SPEED;
    this.range = torpedo ? TORPEDO_RANGE : MAX_RANGE;
    this.baseDamage = torpedo ? TORPEDO_DAMAGE : 1;
    this.vx = Math.cos(direction) * this.speed;
    this.vy = Math.sin(direction) * this.speed;
    this.owner = owner;
  }

  update(dt: number) {
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.traveled += this.speed * dt;
    if (this.traveled >= this.range) this.spent = true;
  }

  /** Impact falls off with distance flown: point-blank ≈ full, max range ≈ 40%. */
  get damage(): number {
    return this.baseDamage * (1 - 0.6 * Math.min(this.traveled / this.range, 1));
  }

  draw(ctx: CanvasRenderingContext2D) {
    drawCannonball(ctx, this.x, this.y, this.vx, this.vy, this.torpedo);
  }
}

/**
 * A shot in flight, drawn as a thin laser bolt oriented along its velocity:
 * a soft outer glow, a bright mid-beam, a hot white core, and a leading head.
 * Reads clearly against the sea. Shared by the host (Cannonball) and the guest
 * renderer (which only has position + velocity).
 */
export function drawCannonball(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  vx: number,
  vy: number,
  torpedo = false,
) {
  const sp = Math.hypot(vx, vy) || 1;
  const ux = vx / sp;
  const uy = vy / sp;

  const tailX = x - ux * (torpedo ? 22 : 16);
  const tailY = y - uy * (torpedo ? 22 : 16);
  const headX = x + ux * 3;
  const headY = y + uy * 3;

  ctx.lineCap = 'round';

  // Outer glow — warm for cannonballs, cold cyan for torpedoes.
  ctx.strokeStyle = torpedo ? 'rgba(80, 220, 255, 0.4)' : 'rgba(255, 90, 40, 0.35)';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(tailX, tailY);
  ctx.lineTo(headX, headY);
  ctx.stroke();

  // Bright mid-beam.
  ctx.strokeStyle = 'rgba(255, 170, 60, 0.85)';
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.moveTo(tailX, tailY);
  ctx.lineTo(headX, headY);
  ctx.stroke();

  // Hot white core.
  ctx.strokeStyle = '#fff3c0';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(tailX, tailY);
  ctx.lineTo(headX, headY);
  ctx.stroke();

  // Leading head.
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(headX, headY, 1.7, 0, Math.PI * 2);
  ctx.fill();
}
