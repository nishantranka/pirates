import { CANNONBALL_SPEED } from './cannonball';
import type { Ship, Turn } from './ship';
import type { Wind } from './wind';

const DEAD_ZONE = 0.08; // rad; don't jitter when roughly on course
const BROADSIDE_RANGE = 280; // px; inside this, turn to bring the broadside to bear
const FIRE_RANGE = 300; // px
const FIRE_CONE = 0.25; // rad off perfect broadside alignment
const UPWIND_CONE = 0.6; // rad off dead-upwind the wind-aware captain refuses to chase into

export interface AiOptions {
  leadShots: boolean; // aim at where the target will be, not where it is
  windAware: boolean; // avoid chasing straight into the wind
  wind: Wind;
}

/** Signed shortest angle from b to a, in (-PI, PI]. */
export function angleDiff(a: number, b: number): number {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

/** Where to aim: the target's predicted position at cannonball arrival, or its current one. */
function aimPoint(self: Ship, target: Ship, opts: AiOptions): { x: number; y: number } {
  if (!opts.leadShots) return { x: target.x, y: target.y };
  const flightTime = Math.hypot(target.x - self.x, target.y - self.y) / CANNONBALL_SPEED;
  const v = target.speed * opts.wind.speedFactor(target.heading);
  return {
    x: target.x + Math.cos(target.heading) * v * flightTime,
    y: target.y + Math.sin(target.heading) * v * flightTime,
  };
}

/** Chase the target from afar; once close, turn so the starboard guns bear. */
export function decideTurn(self: Ship, target: Ship, opts: AiOptions): Turn {
  const aim = aimPoint(self, target, opts);
  const bearing = Math.atan2(aim.y - self.y, aim.x - self.x);
  const dist = Math.hypot(target.x - self.x, target.y - self.y);

  let desired = bearing;
  if (dist < BROADSIDE_RANGE) {
    // Guns are on the starboard rail only: put the target 90° to starboard.
    desired = bearing - Math.PI / 2;
  } else if (opts.windAware) {
    // Chasing dead upwind means crawling at 40% speed; steer along the
    // nearest edge of the slow cone instead and keep the sails drawing.
    const upwind = opts.wind.direction + Math.PI;
    const offUpwind = angleDiff(desired, upwind);
    if (Math.abs(offUpwind) < UPWIND_CONE) {
      desired = upwind + (offUpwind >= 0 ? UPWIND_CONE : -UPWIND_CONE);
    }
  }

  const diff = angleDiff(desired, self.heading);
  if (diff > DEAD_ZONE) return 1;
  if (diff < -DEAD_ZONE) return -1;
  return 0;
}

/** Fire when the aim point is in range and ~90° to starboard (where the guns are). */
export function wantsToFire(self: Ship, target: Ship, opts: AiOptions): boolean {
  const aim = aimPoint(self, target, opts);
  const dist = Math.hypot(aim.x - self.x, aim.y - self.y);
  if (dist > FIRE_RANGE) return false;
  const bearing = Math.atan2(aim.y - self.y, aim.x - self.x);
  const offBow = angleDiff(bearing, self.heading);
  return Math.abs(offBow - Math.PI / 2) < FIRE_CONE;
}
