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
// Speed and turn rate are 1.5× the base tuning for a brisker pace (handling
// ratio is preserved since both scale together).
// The submarine (multiplayer only) is engine-powered — wind never touches it —
// fires a single bow torpedo, and can dive to evade (see multiplayer.ts).
export const SHIP_TYPES = {
  small: { speed: 165, turnRate: 2.4, maxHealth: 3, guns: 2, length: 42, width: 17 },
  medium: { speed: 120, turnRate: 1.8, maxHealth: 5, guns: 3, length: 56, width: 22 },
  large: { speed: 82.5, turnRate: 1.35, maxHealth: 8, guns: 4, length: 72, width: 28 },
  submarine: { speed: 120, turnRate: 1.8, maxHealth: 4, guns: 1, length: 58, width: 16 },
} as const satisfies Record<string, ShipStats>;

export type ShipTypeName = keyof typeof SHIP_TYPES;

/** The classic sailing hulls — what enemy AI and bots choose from. */
export const SAIL_TYPES: ShipTypeName[] = ['small', 'medium', 'large'];

/** Your own hull is always this pink, so you can spot yourself instantly. */
export const YOU_COLOR = '#ff4fa0';

/** Submarine dive tuning, shared by practice (game.ts) and multiplayer. */
export const DIVE = {
  max: 6, // s of submersion charge
  refill: 0.55, // charge regained per second while surfaced
  anim: 1.0, // s to fully submerge or surface
  immune: 0.6, // depth beyond which shots/rams pass over
  hidden: 0.5, // depth beyond which enemies can't see you
} as const;

const SINK_DURATION = 1.5; // s to fade out after health hits 0

/** Shortest signed delta from 0 to d on a wrapping axis of the given size. */
export function wrapDelta(d: number, size: number): number {
  return d - Math.round(d / size) * size;
}

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
  shield = 0; // remaining shield hits that will be absorbed (multiplayer power-up)
  boostFactor = 1; // speed multiplier from the speed power-up
  depth = 0; // submarine: 0 surfaced → 1 fully submerged
  /** Fading wake behind the hull; purely visual, maintained by the renderer. */
  wake: Array<{ x: number; y: number; t: number }> = [];
  /** Renderer hint: double-broadside power-up active — the fixed gun stubs
   *  on both gunwales draw longer and glow gold while it runs. */
  gunHighlight = false;

  readonly type: ShipTypeName;
  readonly length: number;
  readonly width: number;

  hullColor: string; // public so the local client can repaint its own ship pink

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
    const v = this.speed * speedFactor * this.boostFactor;
    this.x += Math.cos(this.heading) * v * dt;
    this.y += Math.sin(this.heading) * v * dt;

    // Wrap the moment the center crosses an edge. drawWrapped() renders ghost
    // copies of the overhanging halves on both sides, so the swap is pixel-
    // identical and the crossing looks perfectly continuous — and the center
    // (where health bars, name tags, etc. anchor) is always on screen.
    this.x = ((this.x % worldW) + worldW) % worldW;
    this.y = ((this.y % worldH) + worldH) % worldH;
  }

  /** Is the point inside this ship's oriented bounding box? */
  containsPoint(px: number, py: number): boolean {
    return this.containsDelta(px - this.x, py - this.y);
  }

  /** containsPoint on a wrapping world: also catches hits on the ghost copies
   *  a boundary-straddling hull shows on the far side. */
  containsPointWrapped(px: number, py: number, worldW: number, worldH: number): boolean {
    return this.containsDelta(wrapDelta(px - this.x, worldW), wrapDelta(py - this.y, worldH));
  }

  private containsDelta(dx: number, dy: number): boolean {
    const cos = Math.cos(-this.heading);
    const sin = Math.sin(-this.heading);
    const localX = dx * cos - dy * sin;
    const localY = dx * sin + dy * cos;
    return Math.abs(localX) <= this.length / 2 && Math.abs(localY) <= this.width / 2;
  }

  /**
   * Draw the hull plus ghost copies across wrapped edges, so crossing the
   * world boundary looks continuous — the bow emerges on the far side the
   * moment the stern starts leaving this one.
   */
  drawWrapped(ctx: CanvasRenderingContext2D, worldW: number, worldH: number) {
    const m = this.length; // matches the wrap margin in update()
    const xs = [0];
    if (this.x < m) xs.push(worldW);
    if (this.x > worldW - m) xs.push(-worldW);
    const ys = [0];
    if (this.y < m) ys.push(worldH);
    if (this.y > worldH - m) ys.push(-worldH);
    for (const dx of xs) {
      for (const dy of ys) {
        if (dx === 0 && dy === 0) {
          this.draw(ctx);
        } else {
          ctx.save();
          ctx.translate(dx, dy);
          this.draw(ctx);
          ctx.restore();
        }
      }
    }
  }

  draw(ctx: CanvasRenderingContext2D) {
    if (this.sinkProgress >= 1) return;

    ctx.save();
    // Sinking fades the hull; a diving submarine dims and shrinks slightly.
    ctx.globalAlpha = (1 - this.sinkProgress) * (1 - 0.45 * this.depth);
    ctx.translate(this.x, this.y);
    ctx.rotate(this.heading);
    const dive = 1 - 0.15 * this.depth;
    ctx.scale(dive, dive);

    const l = this.length;
    const w = this.width;

    if (this.type === 'submarine') {
      // Cigar hull with a rounded bow and tapered stern.
      ctx.beginPath();
      ctx.moveTo(l / 2, 0);
      ctx.quadraticCurveTo(l / 3, -w / 2, -l / 3, -w / 2);
      ctx.quadraticCurveTo(-l / 2, -w / 6, -l / 2, 0);
      ctx.quadraticCurveTo(-l / 2, w / 6, -l / 3, w / 2);
      ctx.quadraticCurveTo(l / 3, w / 2, l / 2, 0);
      ctx.closePath();
      ctx.fillStyle = this.hullColor;
      ctx.fill();
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Bow torpedo tube: a slim rounded stub ahead of the bow — the sub
      // always fires straight forward.
      ctx.strokeStyle = 'rgba(22, 27, 33, 0.8)';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(l / 2 - 2, 0);
      ctx.lineTo(l / 2 + 6, 0);
      ctx.stroke();

      // Conning tower + periscope dot.
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.beginPath();
      ctx.ellipse(-l * 0.05, 0, l * 0.16, w * 0.32, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#e8e8e8';
      ctx.beginPath();
      ctx.arc(l * 0.06, 0, 2.2, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
      return;
    }

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

    // Cannon muzzles: slim rounded stubs just past both gunwales — a fixed
    // part of the ship art (broadsides always fire perpendicular to the hull,
    // either side). While double broadside runs they lengthen and glow gold.
    ctx.strokeStyle = this.gunHighlight ? '#ffd75e' : 'rgba(22, 27, 33, 0.8)';
    ctx.lineWidth = this.gunHighlight ? 3 : 2.2;
    ctx.lineCap = 'round';
    const reach = this.gunHighlight ? w * 0.74 : w * 0.62;
    for (const s of [1, -1]) {
      for (let i = 0; i < this.guns; i++) {
        const gx = (this.guns === 1 ? 0 : i / (this.guns - 1) - 0.5) * (l / 2);
        ctx.beginPath();
        ctx.moveTo(gx, s * w * 0.34);
        ctx.lineTo(gx, s * reach);
        ctx.stroke();
      }
    }

    ctx.restore();
  }
}
