export type Turn = -1 | 0 | 1;

export interface ShipStats {
  speed: number; // px/s
  turnRate: number; // rad/s
  maxHealth: number; // cannonball hits to sink
  guns: number; // cannonballs per broadside
  length: number; // px
  width: number; // px
}

// Small ships are fast but fragile; large ships are slow but tough.
export const SHIP_TYPES = {
  small: { speed: 110, turnRate: 1.6, maxHealth: 3, guns: 2, length: 42, width: 17 },
  medium: { speed: 80, turnRate: 1.2, maxHealth: 5, guns: 3, length: 56, width: 22 },
  large: { speed: 55, turnRate: 0.9, maxHealth: 8, guns: 4, length: 72, width: 28 },
} as const satisfies Record<string, ShipStats>;

export type ShipTypeName = keyof typeof SHIP_TYPES;

const SINK_DURATION = 1.5; // s to fade out after health hits 0

export class Ship {
  x: number;
  y: number;
  heading: number; // radians, 0 = pointing right (+x)
  speed: number;
  turnRate: number;
  maxHealth: number;
  health: number;
  guns: number;
  reload = 0; // s until cannons are ready again
  sinkProgress = 0; // 0 afloat → 1 fully sunk

  readonly type: ShipTypeName;
  readonly length: number;
  readonly width: number;

  private hullColor: string;

  constructor(x: number, y: number, heading: number, hullColor: string, type: ShipTypeName) {
    const stats = SHIP_TYPES[type];
    this.x = x;
    this.y = y;
    this.heading = heading;
    this.hullColor = hullColor;
    this.type = type;
    this.speed = stats.speed;
    this.turnRate = stats.turnRate;
    this.maxHealth = stats.maxHealth;
    this.health = stats.maxHealth;
    this.guns = stats.guns;
    this.length = stats.length;
    this.width = stats.width;
  }

  get alive(): boolean {
    return this.health > 0;
  }

  takeHit(amount = 1) {
    this.health = Math.max(0, this.health - amount);
  }

  update(dt: number, turn: Turn, worldW: number, worldH: number, speedFactor = 1) {
    this.reload = Math.max(0, this.reload - dt);

    if (!this.alive) {
      this.sinkProgress = Math.min(1, this.sinkProgress + dt / SINK_DURATION);
      return;
    }

    this.heading += turn * this.turnRate * dt;
    this.x += Math.cos(this.heading) * this.speed * speedFactor * dt;
    this.y += Math.sin(this.heading) * this.speed * speedFactor * dt;

    // Wrap around world edges, with margin so the ship fully leaves first.
    const m = this.length;
    if (this.x < -m) this.x = worldW + m;
    if (this.x > worldW + m) this.x = -m;
    if (this.y < -m) this.y = worldH + m;
    if (this.y > worldH + m) this.y = -m;
  }

  /** Is the point inside this ship's oriented bounding box? */
  containsPoint(px: number, py: number): boolean {
    const dx = px - this.x;
    const dy = py - this.y;
    const cos = Math.cos(-this.heading);
    const sin = Math.sin(-this.heading);
    const localX = dx * cos - dy * sin;
    const localY = dx * sin + dy * cos;
    return Math.abs(localX) <= this.length / 2 && Math.abs(localY) <= this.width / 2;
  }

  draw(ctx: CanvasRenderingContext2D) {
    if (this.sinkProgress >= 1) return;

    ctx.save();
    ctx.globalAlpha = 1 - this.sinkProgress;
    ctx.translate(this.x, this.y);
    ctx.rotate(this.heading);

    const l = this.length;
    const w = this.width;

    // Hull: pointed bow (+x), flat stern.
    ctx.beginPath();
    ctx.moveTo(l / 2, 0);
    ctx.quadraticCurveTo(l / 6, -w / 2, -l / 2, -w / 2.6);
    ctx.lineTo(-l / 2, w / 2.6);
    ctx.quadraticCurveTo(l / 6, w / 2, l / 2, 0);
    ctx.closePath();
    ctx.fillStyle = this.hullColor;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Deck line.
    ctx.beginPath();
    ctx.moveTo(l / 2 - 6, 0);
    ctx.lineTo(-l / 2 + 4, 0);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.25)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Square sails: two masts, sails set across the hull.
    ctx.fillStyle = '#f3ead7';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
    for (const mastX of [l / 6, -l / 5]) {
      ctx.beginPath();
      ctx.rect(mastX - 3, -w * 0.75, 6, w * 1.5);
      ctx.fill();
      ctx.stroke();
    }

    ctx.restore();
  }
}
