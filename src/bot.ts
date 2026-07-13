// AI captains for multiplayer free-for-alls. Runs on the host only — a bot is
// just a player slot whose inputs come from decideBot() instead of the wire.
//
// Doctrine: hunt the most promising target (close and already damaged), lead
// shots accounting for wind, and never waste a broadside into an island. When
// wounded with an enemy bearing down, break off and run — preferring headings
// with strong wind and with an island between us and the threat. Power-ups
// are part of the plan: a hurting bot detours for health or a shield, a
// healthy hunter grabs rapid fire or a double broadside.

import { angleDiff } from './ai';
import { CANNONBALL_SPEED } from './cannonball';
import { islandHitsPoint, segmentHitsIsland, type IslandData } from './island';
import type { PickupType } from './net';
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

/** What the bot can see of a floating bounty. */
export interface PickupInfo {
  type: PickupType;
  x: number;
  y: number;
}

/** The bot's own active offensive buffs (no point stacking another). */
export interface BotBuffState {
  dbl: boolean;
  mg: boolean;
}

const PICKUP_RANGE = 520; // px; don't cross the map for a bounty
const PICKUP_DIST_COST = 1 / 200; // utility lost per px of detour

/**
 * How much this bot wants a pickup of the given type right now. 0 = skip.
 * Hurting bots value staying alive (health, shield, speed); healthy hunters
 * value firepower; survivor-mode bots barely care about guns at all.
 */
function pickupUtility(
  type: PickupType,
  self: Ship,
  buffs: BotBuffState,
  wounded: boolean,
  survival: boolean,
): number {
  switch (type) {
    case 'health': {
      const missing = self.maxHealth - self.health;
      return missing <= 0 ? 0 : (wounded ? 2.6 : 0.9) + missing * 0.5;
    }
    case 'shield':
      return self.shield > 1 ? 0 : survival || wounded ? 2.4 : 1.3;
    case 'speed':
      return self.boostFactor > 1 ? 0 : survival || wounded ? 1.9 : 1.2;
    case 'double':
      return buffs.dbl || wounded ? 0 : survival ? 0.4 : 1.7;
    case 'machinegun':
      return buffs.mg || wounded ? 0 : survival ? 0.4 : 2.1;
  }
}

/** The best bounty worth a detour right now, or null to keep fighting. */
function pickPickup(
  self: Ship,
  pickups: PickupInfo[],
  buffs: BotBuffState,
  wounded: boolean,
  survival: boolean,
  threat: Ship | null, // set while fleeing: never grab toward the hunter
  islands: IslandData[],
  eye?: { x: number; y: number; r: number },
): PickupInfo | null {
  let best: PickupInfo | null = null;
  let bestScore = 0; // must stay positive after the distance cost
  for (const p of pickups) {
    const want = pickupUtility(p.type, self, buffs, wounded, survival);
    if (want <= 0) continue;
    const d = Math.hypot(p.x - self.x, p.y - self.y);
    if (d > PICKUP_RANGE) continue;
    // Not into the maelstrom, not toward the ship chasing us, not through sand.
    if (eye && Math.hypot(p.x - eye.x, p.y - eye.y) > eye.r - 40) continue;
    if (
      threat &&
      Math.hypot(p.x - threat.x, p.y - threat.y) < Math.hypot(self.x - threat.x, self.y - threat.y)
    )
      continue;
    if (segmentHitsIsland(islands, self.x, self.y, p.x, p.y)) continue;
    const score = want - d * PICKUP_DIST_COST;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
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

/** Chase from afar (avoiding the upwind crawl); swing the starboard guns on when close. */
function fightHeading(self: Ship, target: Ship, wind: Wind): number {
  const aim = aimPoint(self, target, wind);
  const bearing = Math.atan2(aim.y - self.y, aim.x - self.x);
  const dist = Math.hypot(target.x - self.x, target.y - self.y);

  if (dist < BROADSIDE_RANGE) {
    // Guns are on the starboard rail only: put the target 90° to starboard.
    return bearing - Math.PI / 2;
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

/** Would `a`'s broadside bear on `b` right now (b ~90° to a's starboard,
 *  the only side ships fire from)? */
function broadsideBears(a: Ship, b: Ship, cone = FIRE_CONE): boolean {
  const bearing = Math.atan2(b.y - a.y, b.x - a.x);
  const offBow = angleDiff(bearing, a.heading);
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
      // Only the enemy's starboard arc is dangerous — that's where guns fire.
      const offBeam = Math.abs(angleDiff(bFromE, e.heading) - Math.PI / 2);
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

const RAM_SEEK_RANGE = 155; // px; charge a weaker enemy this close
const RAM_SEEK_BOW = 0.5; // must be roughly ahead of us to be worth charging

/** A weaker enemy that's close and ahead, worth ramming — else null.
 *  A bow hit deals 3 and costs us 1, so it's worth it against anyone weaker —
 *  but never on our last hit points, and never into a waiting bow (bow-to-bow
 *  costs us 3 too). */
function pickRamTarget(self: Ship, enemies: Ship[], islands: IslandData[]): Ship | null {
  let best: Ship | null = null;
  let bestDist = RAM_SEEK_RANGE;
  if (self.health <= 1) return null; // the 1hp return damage would sink us
  for (const e of enemies) {
    const d = Math.hypot(e.x - self.x, e.y - self.y);
    if (d > bestDist) continue;
    if (e.health > self.health) continue; // don't ram someone tougher
    const bearing = Math.atan2(e.y - self.y, e.x - self.x);
    if (Math.cos(angleDiff(bearing, self.heading)) < RAM_SEEK_BOW) continue; // must be ahead
    // A facing bow means a 3-for-3 trade — only worth it if we out-hull them.
    if (Math.cos(angleDiff(e.heading, bearing + Math.PI)) > 0.5 && e.health >= self.health)
      continue;
    if (segmentHitsIsland(islands, self.x, self.y, e.x, e.y)) continue; // don't charge through sand
    bestDist = d;
    best = e;
  }
  return best;
}

export function decideBot(
  self: Ship,
  ships: Ship[],
  islands: IslandData[],
  wind: Wind,
  eye?: { x: number; y: number; r: number },
  survival = false,
  pickups: PickupInfo[] = [],
  buffs: BotBuffState = { dbl: false, mg: false },
): BotDecision {
  // Submerged submarines are invisible — bots can't target what they can't see.
  const enemies = ships.filter((s) => s !== self && s.alive && s.depth <= 0.5);
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

  // Survivor mode: staying afloat is all that matters. Never hunt, never ram —
  // keep distance from everyone and only trade defensive broadsides in passing.
  const wounded = self.health <= Math.max(2, self.maxHealth * FLEE_HEALTH);
  const fleeing = survival ? threatDist < 430 : wounded && threatDist < FLEE_TRIGGER;
  // When healthy but being raked, break the geometry instead of sitting in it.
  const raker = fleeing ? null : broadsideThreat(self, enemies);
  // Ram opportunity: a weaker enemy close and ahead — charge the bow through it.
  const ramTarget =
    survival || fleeing || raker ? null : pickRamTarget(self, enemies, islands);

  // Power-up plan: a bounty worth a detour given our situation (hurting →
  // health/shield/speed; healthy hunter → firepower). Escaping a raker's
  // kill-zone still comes first.
  const goal = raker
    ? null
    : pickPickup(self, pickups, buffs, wounded, survival, fleeing ? threat : null, islands, eye);

  let desired: number;
  if (fleeing && !goal) desired = fleeHeading(self, threat, islands, wind);
  else if (raker) desired = evadeHeading(self, raker, enemies, islands, wind);
  else if (goal) desired = Math.atan2(goal.y - self.y, goal.x - self.x);
  else if (ramTarget) desired = Math.atan2(ramTarget.y - self.y, ramTarget.x - self.x);
  else if (survival) desired = self.heading; // nobody near: hold course, stay out of trouble
  else desired = fightHeading(self, target, wind);

  // Whirlpool awareness: never sail out of the eye. If already outside, head
  // straight back to the middle. If near the inner edge and the chosen heading
  // would carry us out, turn in *before* crossing — the margin is our turning
  // radius, so we come about while there's still room.
  if (eye) {
    const rx = self.x - eye.x;
    const ry = self.y - eye.y;
    const d = Math.hypot(rx, ry) || 1;
    const outward = Math.atan2(ry, rx); // radially outward from the eye center
    const turnRadius = (self.speed * self.boostFactor) / self.turnRate;
    const margin = turnRadius + 25;
    const headingOut = Math.cos(angleDiff(desired, outward)) > 0; // desired points outward-ish
    if (d > eye.r || (d > eye.r - margin && headingOut)) {
      desired = outward + Math.PI; // steer to the eye center
    }
  }

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
    const offBow = angleDiff(bearing, self.heading); // signed: guns face starboard
    fire =
      Math.abs(offBow - Math.PI / 2) < FIRE_CONE &&
      !segmentHitsIsland(islands, self.x, self.y, aim.x, aim.y);
  }

  return { turn, fire };
}
