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

// ── Blocky (Minecraft-style) rendering ────────────────────────────────────────
// Islands rasterize onto a world-aligned tile grid so the coastline is a hard,
// readable edge: one ring of translucent "shallow water" blocks warns you,
// then solid sand/grass blocks mean death. Tiles derive deterministically
// from the island data (coordinate hash, no RNG), so every peer renders the
// exact same terrain. Rasterization is cached per island.

const TILE = 18;

interface Tile {
  px: number; // top-left corner, world coords
  py: number;
  kind: 'shallow' | 'sand' | 'sand2' | 'grass' | 'grass2';
}

const TILE_COLORS: Record<Tile['kind'], string> = {
  shallow: 'rgba(130, 205, 228, 0.45)',
  sand: '#e3d08f',
  sand2: '#d8c37e',
  grass: '#7cb850',
  grass2: '#66a03e',
};

const OUTLINE_COLOR = '#463320'; // dark grout between blocks + silhouette border

const tileCache = new WeakMap<IslandData, Tile[]>();

/** Deterministic pseudo-random in [0,1) from tile coordinates. */
function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = ((h ^ (h >>> 13)) * 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** How far inside the island a point is (px); negative = open water. */
function depthInside(island: IslandData, x: number, y: number): number {
  let best = -Infinity;
  for (const c of island.circles) {
    best = Math.max(best, c.r - Math.hypot(x - c.x, y - c.y));
  }
  return best;
}

function tilesFor(island: IslandData): Tile[] {
  const cached = tileCache.get(island);
  if (cached) return cached;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of island.circles) {
    minX = Math.min(minX, c.x - c.r);
    minY = Math.min(minY, c.y - c.r);
    maxX = Math.max(maxX, c.x + c.r);
    maxY = Math.max(maxY, c.y + c.r);
  }

  const tiles: Tile[] = [];
  const tx0 = Math.floor((minX - TILE * 1.5) / TILE);
  const ty0 = Math.floor((minY - TILE * 1.5) / TILE);
  const tx1 = Math.ceil((maxX + TILE * 1.5) / TILE);
  const ty1 = Math.ceil((maxY + TILE * 1.5) / TILE);

  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const cx = tx * TILE + TILE / 2;
      const cy = ty * TILE + TILE / 2;
      const d = depthInside(island, cx, cy);
      let kind: Tile['kind'] | null = null;
      if (d >= TILE * 1.6) {
        kind = hash2(tx, ty) < 0.3 ? 'grass2' : 'grass';
      } else if (d >= 0) {
        kind = hash2(tx, ty) < 0.4 ? 'sand2' : 'sand';
      } else if (d >= -TILE * 1.15) {
        kind = 'shallow';
      }
      if (kind) tiles.push({ px: tx * TILE, py: ty * TILE, kind });
    }
  }

  tileCache.set(island, tiles);
  return tiles;
}

export function drawIsland(ctx: CanvasRenderingContext2D, island: IslandData) {
  const tiles = tilesFor(island);

  // Shallow warning ring: translucent blocky water, no outline.
  ctx.fillStyle = TILE_COLORS.shallow;
  for (const t of tiles) {
    if (t.kind === 'shallow') ctx.fillRect(t.px + 1, t.py + 1, TILE - 2, TILE - 2);
  }

  // Dark base layer under every land block → silhouette border + grout lines.
  ctx.fillStyle = OUTLINE_COLOR;
  for (const t of tiles) {
    if (t.kind !== 'shallow') ctx.fillRect(t.px - 2, t.py - 2, TILE + 4, TILE + 4);
  }

  // Land blocks, inset so the dark base shows through as seams.
  for (const t of tiles) {
    if (t.kind === 'shallow') continue;
    ctx.fillStyle = TILE_COLORS[t.kind];
    ctx.fillRect(t.px + 1, t.py + 1, TILE - 2, TILE - 2);
  }

  // Blocky trees: brown trunk block with a plus-shaped leaf canopy.
  for (const p of island.palms) {
    const tx = Math.floor(p.x / TILE) * TILE;
    const ty = Math.floor(p.y / TILE) * TILE;

    ctx.fillStyle = '#6b4a2a';
    ctx.fillRect(tx + 4, ty + 4, TILE - 8, TILE - 8);

    const leaves: Array<[number, number]> = [
      [0, -TILE],
      [-TILE, 0],
      [TILE, 0],
      [0, TILE],
      [0, 0],
    ];
    for (const [ox, oy] of leaves) {
      ctx.fillStyle = hash2((tx + ox) / TILE, (ty + oy) / TILE) < 0.5 ? '#3e7d3a' : '#356e33';
      const inset = ox === 0 && oy === 0 ? 5 : 3;
      ctx.fillRect(tx + ox + inset, ty + oy + inset, TILE - inset * 2, TILE - inset * 2);
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

/** Does the segment (x1,y1)→(x2,y2) cross any island? Used for line-of-sight. */
export function segmentHitsIsland(
  islands: IslandData[],
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): boolean {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  for (const island of islands) {
    for (const c of island.circles) {
      let t = lenSq > 0 ? ((c.x - x1) * dx + (c.y - y1) * dy) / lenSq : 0;
      t = Math.max(0, Math.min(1, t));
      const px = x1 + dx * t;
      const py = y1 + dy * t;
      if (Math.hypot(c.x - px, c.y - py) <= c.r) return true;
    }
  }
  return false;
}

/** Does the ship's hull touch any island? Running aground is fatal. */
export function shipHitsIsland(
  islands: IslandData[],
  ship: { x: number; y: number; width: number },
): boolean {
  const pad = ship.width * 0.55;
  for (const island of islands) {
    for (const c of island.circles) {
      if (Math.hypot(ship.x - c.x, ship.y - c.y) < c.r + pad) return true;
    }
  }
  return false;
}
