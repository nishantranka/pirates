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
const FLEE_TRIGGER = 340; // px; threat distance that makes a wounded bot run
const FLEE_HEALTH = 0.4; // flee at/below this health fraction (min 2 points)

// Grounding is fatal, so steering is safety-checked by simulating the ship's
// real turning kinematics this far into the future.
const SIM_HORIZON = 2.6; // s
const SIM_STEP = 0.15; // s
const SIM_PAD = 0.9; // × ship width kept clear of the sand (real kill pad is 0.55)

const THREAT_RANGE = FIRE_RANGE + 60; // px; an enemy this close on our beam is raking us

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
    if (segmentHitsIsland(islands, self.x, self.y, fx, fy)) score -= 1.5; // …or sail through sand
    if (segmentHitsIsland(islands, threat.x, threat.y, fx, fy)) score += 0.8; // island = cover
    if (score > bestScore) {
      bestScore = score;
      best = a;
    }
  }
  return best;
}

/**
 * Seconds until this steering choice runs the ship aground, simulated with the
 * ship's actual turn rate and speed. Returns the full horizon if the path is clear.
 */
function timeToImpact(self: Ship, turn: Turn, islands: IslandData[]): number {
  let x = self.x;
  let y = self.y;
  let h = self.heading;
  const pad = self.width * SIM_PAD;
  for (let t = SIM_STEP; t <= SIM_HORIZON; t += SIM_STEP) {
    h += turn * self.turnRate * SIM_STEP;
    x += Math.cos(h) * self.speed * SIM_STEP;
    y += Math.sin(h) * self.speed * SIM_STEP;
    for (const island of islands) {
      for (const c of island.circles) {
        if (Math.hypot(x - c.x, y - c.y) < c.r + pad) return t;
      }
    }
  }
  return SIM_HORIZON;
}

/**
 * Take the preferred turn if its simulated path stays off the sand; otherwise
 * fall back to the alternative that survives longest.
 */
function safestTurn(self: Ship, desired: Turn, islands: IslandData[]): Turn {
  const options: Turn[] =
    desired === 0 ? [0, 1, -1] : desired === 1 ? [1, 0, -1] : [-1, 0, 1];
  let bestTurn = desired;
  let bestTti = -1;
  for (const t of options) {
    const tti = timeToImpact(self, t, islands);
    if (tti >= SIM_HORIZON) return t;
    if (tti > bestTti) {
      bestTti = tti;
      bestTurn = t;
    }
  }
  return bestTurn;
}

/** Would `a`'s broadside bear on `b` right now (b roughly 90° off a's bow)? */
function broadsideBears(a: Ship, b: Ship, cone = FIRE_CONE): boolean {
  const bearing = Math.atan2(b.y - a.y, b.x - a.x);
  const offBow = Math.abs(angleDiff(bearing, a.heading));
  return Math.abs(offBow - Math.PI / 2) < cone;
}

/**
 * The enemy currently raking us: one whose broadside bears on us, in range,
 * that we can't answer this instant. This is the "sitting duck" a human
 * exploits by crossing our bow, firing, and fleeing. A fair mutual broadside
 * is not a threat — we trade, we don't flinch.
 */
function broadsideThreat(self: Ship, enemies: Ship[]): Ship | null {
  let worst: Ship | null = null;
  let worstScore = 0;
  for (const e of enemies) {
    const dist = Math.hypot(e.x - self.x, e.y - self.y);
    if (dist > THREAT_RANGE) continue;
    if (!broadsideBears(e, self, FIRE_CONE * 1.7)) continue;
    if (broadsideBears(self, e, FIRE_CONE * 1.7) && self.reload <= 0.7) continue; // mutual — trade
    const score = THREAT_RANGE - dist + (e.reload <= 0.7 ? 150 : 0);
    if (score > worstScore) {
      worstScore = score;
      worst = e;
    }
  }
  return worst;
}

/**
 * Break out of a broadside kill-zone and set up a rake: score candidate
 * headings by clearing every enemy's broadside cone, reaching the raker's
 * stern blind spot, keeping the sails full, and dodging sand.
 */
function evadeHeading(
  self: Ship,
  raker: Ship,
  enemies: Ship[],
  islands: IslandData[],
  wind: Wind,
): number {
  let best = self.heading;
  let bestScore = -Infinity;
  for (let off = -Math.PI + 0.001; off < Math.PI; off += Math.PI / 9) {
    const a = self.heading + off;
    const fx = self.x + Math.cos(a) * 130;
    const fy = self.y + Math.sin(a) * 130;

    let score = wind.speedFactor(a) * 0.5 - Math.abs(off) * 0.12;
    if (islandHitsPoint(islands, fx, fy)) score -= 6;
    if (segmentHitsIsland(islands, self.x, self.y, fx, fy)) score -= 3;

    for (const e of enemies) {
      const bFromE = Math.atan2(fy - e.y, fx - e.x);
      const dist = Math.hypot(fx - e.x, fy - e.y);
      const offBeam = Math.abs(Math.abs(angleDiff(bFromE, e.heading)) - Math.PI / 2);
      if (dist < FIRE_RANGE && offBeam < 0.5) score -= e.reload <= 0.7 ? 2.5 : 1.2;
      if (e === raker) {
        const astern = Math.abs(angleDiff(bFromE, e.heading + Math.PI));
        if (astern < 0.8 && dist < FIRE_RANGE) score += 1.6; // rake from behind
      }
    }

    if (score > bestScore) {
      bestScore = score;
      best = a;
    }
  }
  return best;
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
  // When healthy but being raked, break the geometry instead of sitting in it.
  const raker = fleeing ? null : broadsideThreat(self, enemies);

  let desired: number;
  if (fleeing) desired = fleeHeading(self, threat, islands, wind);
  else if (raker) desired = evadeHeading(self, raker, enemies, islands, wind);
  else desired = fightHeading(self, target, wind);

  const diff = angleDiff(desired, self.heading);
  const wantedTurn: Turn = diff > DEAD_ZONE ? 1 : diff < -DEAD_ZONE ? -1 : 0;
  // Safety veto: never commit to a turn whose simulated path runs aground.
  const turn = safestTurn(self, wantedTurn, islands);

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
