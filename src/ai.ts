import type { Ship, Turn } from './ship';

const DEAD_ZONE = 0.08; // rad; don't jitter when roughly on course
const BROADSIDE_RANGE = 280; // px; inside this, turn to bring the broadside to bear
const FIRE_RANGE = 300; // px
const FIRE_CONE = 0.25; // rad off perfect broadside alignment

/** Signed shortest angle from b to a, in (-PI, PI]. */
function angleDiff(a: number, b: number): number {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

/** Chase the target from afar; once close, turn sideways so the broadside bears. */
export function decideTurn(self: Ship, target: Ship): Turn {
  const bearing = Math.atan2(target.y - self.y, target.x - self.x);
  const dist = Math.hypot(target.x - self.x, target.y - self.y);

  let desired = bearing;
  if (dist < BROADSIDE_RANGE) {
    const port = bearing - Math.PI / 2;
    const starboard = bearing + Math.PI / 2;
    desired =
      Math.abs(angleDiff(port, self.heading)) < Math.abs(angleDiff(starboard, self.heading))
        ? port
        : starboard;
  }

  const diff = angleDiff(desired, self.heading);
  if (diff > DEAD_ZONE) return 1;
  if (diff < -DEAD_ZONE) return -1;
  return 0;
}

/** Fire when the target is in range and roughly 90° off the bow (broadside bears). */
export function wantsToFire(self: Ship, target: Ship): boolean {
  const dist = Math.hypot(target.x - self.x, target.y - self.y);
  if (dist > FIRE_RANGE) return false;
  const bearing = Math.atan2(target.y - self.y, target.x - self.x);
  const offBow = Math.abs(angleDiff(bearing, self.heading));
  return Math.abs(offBow - Math.PI / 2) < FIRE_CONE;
}
