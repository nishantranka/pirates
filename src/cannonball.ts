import type { Ship } from './ship';

export const CANNONBALL_SPEED = 260; // px/s
const MAX_RANGE = 320; // px before the ball splashes into the sea

export class Cannonball {
  x: number;
  y: number;
  spent = false;
  readonly owner: Ship;

  readonly vx: number;
  readonly vy: number;
  private traveled = 0;

  constructor(x: number, y: number, direction: number, owner: Ship) {
    this.x = x;
    this.y = y;
    this.vx = Math.cos(direction) * CANNONBALL_SPEED;
    this.vy = Math.sin(direction) * CANNONBALL_SPEED;
    this.owner = owner;
  }

  update(dt: number) {
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.traveled += CANNONBALL_SPEED * dt;
    if (this.traveled >= MAX_RANGE) this.spent = true;
  }

  /** Impact falls off with distance flown: point-blank ≈ 1, max range ≈ 0.4. */
  get damage(): number {
    return 1 - 0.6 * Math.min(this.traveled / MAX_RANGE, 1);
  }

  draw(ctx: CanvasRenderingContext2D) {
    drawCannonball(ctx, this.x, this.y, this.vx, this.vy);
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
) {
  const sp = Math.hypot(vx, vy) || 1;
  const ux = vx / sp;
  const uy = vy / sp;

  const tailX = x - ux * 16;
  const tailY = y - uy * 16;
  const headX = x + ux * 3;
  const headY = y + uy * 3;

  ctx.lineCap = 'round';

  // Outer glow.
  ctx.strokeStyle = 'rgba(255, 90, 40, 0.35)';
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
