// Islands are clusters of circles: cheap to collide against, organic to look at.
// The host generates them once per battle and ships the plain data to guests,
// so both sides draw and collide against the exact same terrain.

export interface IslandCircle {
  x: number;
  y: number;
  r: number;
}

export interface Palm {
  x: number;
  y: number;
  a: number; // frond rotation offset, radians
}

export interface IslandData {
  circles: IslandCircle[];
  palms: Palm[];
}

const EDGE_MARGIN = 110; // keep a navigable corridor along world edges (ships wrap there)
const ISLAND_GAP = 150; // min water gap between islands so ships can slip through
const SPAWN_CLEARANCE = 210; // open water guaranteed around each spawn point

export function generateIslands(
  worldW: number,
  worldH: number,
  spawns: Array<{ x: number; y: number }>,
): IslandData[] {
  const islands: IslandData[] = [];
  const target = 5;
  let attempts = 0;

  while (islands.length < target && attempts < 400) {
    attempts++;
    const r = 34 + Math.random() * 40;
    const x = EDGE_MARGIN + r + Math.random() * (worldW - 2 * (EDGE_MARGIN + r));
    const y = EDGE_MARGIN + r + Math.random() * (worldH - 2 * (EDGE_MARGIN + r));

    // Main body plus up to two smaller lobes for irregular coastlines.
    const circles: IslandCircle[] = [{ x, y, r }];
    const lobes = Math.floor(Math.random() * 3);
    for (let i = 0; i < lobes; i++) {
      const a = Math.random() * Math.PI * 2;
      circles.push({
        x: x + Math.cos(a) * r * 0.8,
        y: y + Math.sin(a) * r * 0.8,
        r: r * (0.45 + Math.random() * 0.35),
      });
    }

    if (!fits(circles, islands, spawns, worldW, worldH)) continue;
    islands.push({ circles, palms: makePalms(circles) });
  }

  return islands;
}

function fits(
  circles: IslandCircle[],
  islands: IslandData[],
  spawns: Array<{ x: number; y: number }>,
  worldW: number,
  worldH: number,
): boolean {
  for (const c of circles) {
    if (
      c.x - c.r < EDGE_MARGIN ||
      c.x + c.r > worldW - EDGE_MARGIN ||
      c.y - c.r < EDGE_MARGIN ||
      c.y + c.r > worldH - EDGE_MARGIN
    ) {
      return false;
    }
    for (const s of spawns) {
      if (Math.hypot(c.x - s.x, c.y - s.y) < c.r + SPAWN_CLEARANCE) return false;
    }
    for (const other of islands) {
      for (const o of other.circles) {
        if (Math.hypot(c.x - o.x, c.y - o.y) < c.r + o.r + ISLAND_GAP) return false;
      }
    }
  }
  return true;
}

function makePalms(circles: IslandCircle[]): Palm[] {
  const palms: Palm[] = [];
  for (const c of circles) {
    if (c.r < 46) continue;
    const count = 1 + Math.floor(Math.random() * 2);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.random() * c.r * 0.4;
      palms.push({ x: c.x + Math.cos(a) * d, y: c.y + Math.sin(a) * d, a: Math.random() * Math.PI * 2 });
    }
  }
  return palms;
}

export function drawIsland(ctx: CanvasRenderingContext2D, island: IslandData) {
  // Shallow water halo.
  ctx.fillStyle = 'rgba(125, 195, 220, 0.35)';
  for (const c of island.circles) {
    ctx.beginPath();
    ctx.arc(c.x, c.y, c.r * 1.4, 0, Math.PI * 2);
    ctx.fill();
  }

  // Sand.
  for (const c of island.circles) {
    ctx.beginPath();
    ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
    ctx.fillStyle = '#dcc687';
    ctx.fill();
    ctx.strokeStyle = 'rgba(90, 70, 35, 0.45)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Grass caps on the larger lobes.
  ctx.fillStyle = '#8fae5b';
  for (const c of island.circles) {
    if (c.r < 42) continue;
    ctx.beginPath();
    ctx.arc(c.x, c.y, c.r * 0.55, 0, Math.PI * 2);
    ctx.fill();
  }

  // Palm trees: a leaning trunk with a burst of fronds.
  for (const p of island.palms) {
    ctx.strokeStyle = '#6b4a2a';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y + 7);
    ctx.lineTo(p.x + 4, p.y - 9);
    ctx.stroke();

    ctx.strokeStyle = '#3e7d3a';
    ctx.lineWidth = 2.5;
    for (let i = 0; i < 5; i++) {
      const a = p.a + (i / 5) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(p.x + 4, p.y - 9);
      ctx.quadraticCurveTo(
        p.x + 4 + Math.cos(a) * 7,
        p.y - 9 + Math.sin(a) * 7 - 3,
        p.x + 4 + Math.cos(a) * 12,
        p.y - 9 + Math.sin(a) * 12,
      );
      ctx.stroke();
    }
  }
}

/** Does a point (e.g. a cannonball) sit on any island? Balls splash on the sand. */
export function islandHitsPoint(islands: IslandData[], x: number, y: number): boolean {
  for (const island of islands) {
    for (const c of island.circles) {
      const dx = x - c.x;
      const dy = y - c.y;
      if (dx * dx + dy * dy <= c.r * c.r) return true;
    }
  }
  return false;
}

/** Push a ship out of any island it overlaps so hulls slide along the shore. */
export function resolveShipIslands(
  islands: IslandData[],
  ship: { x: number; y: number; width: number },
) {
  const pad = ship.width * 0.55;
  for (const island of islands) {
    for (const c of island.circles) {
      const dx = ship.x - c.x;
      const dy = ship.y - c.y;
      const d = Math.hypot(dx, dy);
      const min = c.r + pad;
      if (d >= min || d === 0) continue;
      ship.x = c.x + (dx / d) * min;
      ship.y = c.y + (dy / d) * min;
    }
  }
}
