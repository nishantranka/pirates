// AI captains for multiplayer free-for-alls. Runs on the host only — a bot is
// just a player slot whose inputs come from decideBot() instead of the wire.
//
// Doctrine: hunt the most promising target (close and already damaged), lead
// shots accounting for wind, and never waste a broadside into an island. When
// wounded with an enemy bearing down, break off and run — preferring headings
// with strong wind and with an island between us and the threat.

import { angleDiff } from './ai';
import { CANNONBALL_SPEED } from './cannonball';
import { islandHitsPoint, segmentHitsIsland, type IslandData } from './island';
import type { Ship, Turn } from './ship';
import type { Wind } from './wind';

const DEAD_ZONE = 0.08; // rad; don't jitter when roughly on course
const BROADSIDE_RANGE = 280; // px; inside this, turn to bring the guns to bear
const FIRE_RANGE = 300; // px
const FIRE_CONE = 0.25; // rad off perfect broadside alignment
const UPWIND_CONE = 0.6; // rad; don't chase straight into the wind
const LOOKAHEAD = 95; // px ahead scanned for islands
const FLEE_TRIGGER = 340; // px; threat distance that makes a wounded bot run
const FLEE_HEALTH = 0.4; // flee at/below this health fraction (min 2 points)

export interface BotDecision {
  turn: Turn;
  fire: boolean;
}

/** Where to shoot: the target's predicted position at cannonball arrival. */
function aimPoint(self: Ship, target: Ship, wind: Wind): { x: number; y: number } {
  const flightTime = Math.hypot(target.x - self.x, target.y - self.y) / CANNONBALL_SPEED;
  const v = target.speed * wind.speedFactor(target.heading);
  return {
    x: target.x + Math.cos(target.heading) * v * flightTime,
    y: target.y + Math.sin(target.heading) * v * flightTime,
  };
}

/** Chase from afar (avoiding the upwind crawl); swing broadside-on when close. */
function fightHeading(self: Ship, target: Ship, wind: Wind): number {
  const aim = aimPoint(self, target, wind);
  const bearing = Math.atan2(aim.y - self.y, aim.x - self.x);
  const dist = Math.hypot(target.x - self.x, target.y - self.y);

  if (dist < BROADSIDE_RANGE) {
    const port = bearing - Math.PI / 2;
    const starboard = bearing + Math.PI / 2;
    return Math.abs(angleDiff(port, self.heading)) < Math.abs(angleDiff(starboard, self.heading))
      ? port
      : starboard;
  }

  const upwind = wind.direction + Math.PI;
  const offUpwind = angleDiff(bearing, upwind);
  if (Math.abs(offUpwind) < UPWIND_CONE) {
    return upwind + (offUpwind >= 0 ? UPWIND_CONE : -UPWIND_CONE);
  }
  return bearing;
}

/** Run from the threat: fan out candidate headings, score wind speed + cover. */
function fleeHeading(self: Ship, threat: Ship, islands: IslandData[], wind: Wind): number {
  const away = Math.atan2(self.y - threat.y, self.x - threat.x);
  let best = away;
  let bestScore = -Infinity;
  for (const offset of [0, 0.44, -0.44, 0.87, -0.87]) {
    const a = away + offset;
    const fx = self.x + Math.cos(a) * 150;
    const fy = self.y + Math.sin(a) * 150;
    let score = wind.speedFactor(a);
    if (islandHitsPoint(islands, fx, fy)) score -= 2; // don't beach yourself
    if (segmentHitsIsland(islands, threat.x, threat.y, fx, fy)) score += 0.8; // island = cover
    if (score > bestScore) {
      bestScore = score;
      best = a;
    }
  }
  return best;
}

/** If sand lies dead ahead, veer to whichever side swings the bow off it. */
function avoidIslands(self: Ship, desired: number, islands: IslandData[]): number {
  const ax = self.x + Math.cos(self.heading) * LOOKAHEAD;
  const ay = self.y + Math.sin(self.heading) * LOOKAHEAD;
  for (const island of islands) {
    for (const c of island.circles) {
      if (Math.hypot(ax - c.x, ay - c.y) < c.r + self.width) {
        const toCenter = Math.atan2(c.y - self.y, c.x - self.x);
        const s = angleDiff(toCenter, self.heading) >= 0 ? 1 : -1;
        return self.heading - s * 1.1;
      }
    }
  }
  return desired;
}

export function decideBot(
  self: Ship,
  ships: Ship[],
  islands: IslandData[],
  wind: Wind,
): BotDecision {
  const enemies = ships.filter((s) => s !== self && s.alive);
  if (!self.alive || enemies.length === 0) return { turn: 0, fire: false };

  // Nearest threat (for self-preservation) and best target (close + damaged).
  let threat = enemies[0];
  let threatDist = Infinity;
  let target = enemies[0];
  let targetScore = Infinity;
  for (const e of enemies) {
    const d = Math.hypot(e.x - self.x, e.y - self.y);
    if (d < threatDist) {
      threatDist = d;
      threat = e;
    }
    const score = d - (e.maxHealth - e.health) * 40;
    if (score < targetScore) {
      targetScore = score;
      target = e;
    }
  }

  const wounded = self.health <= Math.max(2, self.maxHealth * FLEE_HEALTH);
  const fleeing = wounded && threatDist < FLEE_TRIGGER;

  let desired = fleeing
    ? fleeHeading(self, threat, islands, wind)
    : fightHeading(self, target, wind);
  desired = avoidIslands(self, desired, islands);

  const diff = angleDiff(desired, self.heading);
  const turn: Turn = diff > DEAD_ZONE ? 1 : diff < -DEAD_ZONE ? -1 : 0;

  // Even while fleeing, land parting shots when the broadside happens to bear.
  const aim = aimPoint(self, target, wind);
  const aimDist = Math.hypot(aim.x - self.x, aim.y - self.y);
  let fire = false;
  if (aimDist < FIRE_RANGE) {
    const bearing = Math.atan2(aim.y - self.y, aim.x - self.x);
    const offBow = Math.abs(angleDiff(bearing, self.heading));
    fire =
      Math.abs(offBow - Math.PI / 2) < FIRE_CONE &&
      !segmentHitsIsland(islands, self.x, self.y, aim.x, aim.y);
  }

  return { turn, fire };
}
