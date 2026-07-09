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

  draw(ctx: CanvasRenderingContext2D) {
    drawCannonball(ctx, this.x, this.y, this.vx, this.vy);
  }
}

/**
 * A cannonball in flight, drawn to read clearly against the blue sea: a warm
 * tracer trail behind it, a soft glow, a white-ringed iron body, and a
 * specular highlight. Shared by the host (Cannonball) and the guest renderer
 * (which only has position + velocity).
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

  // Tracer trail.
  ctx.strokeStyle = 'rgba(255, 214, 120, 0.55)';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x - ux * 17, y - uy * 17);
  ctx.lineTo(x, y);
  ctx.stroke();

  // Soft glow.
  ctx.fillStyle = 'rgba(255, 176, 64, 0.35)';
  ctx.beginPath();
  ctx.arc(x, y, 7.5, 0, Math.PI * 2);
  ctx.fill();

  // Iron body with a bright outline.
  ctx.beginPath();
  ctx.arc(x, y, 4.4, 0, Math.PI * 2);
  ctx.fillStyle = '#161616';
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.6;
  ctx.stroke();

  // Highlight.
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.beginPath();
  ctx.arc(x - ux * 1.2 - 1, y - uy * 1.2 - 1, 1.3, 0, Math.PI * 2);
  ctx.fill();
}
