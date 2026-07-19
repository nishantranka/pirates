// Mobile controls and combat assists: direct touch steering, tap-to-fire,
// double-tap diving, and the incoming-shot warning. Used by both practice and
// multiplayer so the two modes feel identical under thumbs. Desktop keyboard
// play is untouched by all of it.

import { wrapDelta } from './ship';

/** True when the device plausibly has a touchscreen. `maxTouchPoints` alone
 *  reports 0 in some Android WebViews (chat-app in-app browsers, where invite
 *  links usually open) and in "request desktop site" mode, so several signals
 *  are consulted — and callers additionally upgrade at runtime on the first
 *  real touch event, which is proof positive. */
export function touchCapable(): boolean {
  if (navigator.maxTouchPoints > 0 || 'ontouchstart' in window) return true;
  return window.matchMedia?.('(any-pointer: coarse)').matches ?? false;
}

const TURN_DEADZONE = 0.12; // rad — stop turning when close enough to the course

/** Which way to turn to reach `desired`, re-evaluated per frame against the
 *  current heading so the ship settles on course instead of oscillating. */
export function turnToward(desired: number, heading: number): -1 | 0 | 1 {
  let d = desired - heading;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  if (Math.abs(d) < TURN_DEADZONE) return 0;
  return d > 0 ? 1 : -1;
}

/** Best-effort immersion when a battle starts on a touch device: fullscreen
 *  plus a landscape lock. Support is inconsistent (iOS Safari refuses both),
 *  so failures are silent and the game continues windowed. Must be called
 *  from a user-gesture handler to have any chance of succeeding. */
export async function requestGameFullscreen() {
  try {
    await document.documentElement.requestFullscreen?.();
    const orientation = screen.orientation as { lock?: (o: string) => Promise<void> } | undefined;
    await orientation?.lock?.('landscape');
  } catch {
    // Browser said no — carry on windowed.
  }
}

/** Tactile feedback on phones that support it (Android; iOS ignores it). */
export function haptic(pattern: number | number[]) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // Some embedded WebViews throw on vibrate — feedback is best-effort.
  }
}

const TAP_MAX_MS = 250;
const DOUBLE_TAP_MAX_MS = 325;
const TAP_MOVE_MAX = 24;
const DOUBLE_TAP_DISTANCE = 48;

interface TrackedTouch {
  startX: number;
  startY: number;
  x: number;
  y: number;
  startedAt: number;
}

/** The first finger on the sea is the helm: while held, its current position
 *  supplies a desired heading. Other fingers can tap to fire without taking
 *  over steering. A quick tap by any finger fires; two nearby quick taps
 *  toggle a submarine's dive state. */
export class TouchControls {
  /** Dive toggle state — double-tap flips it. */
  dive = false;
  /** Current steering-finger position in canvas CSS pixels. Once the finger is
   *  lifted this becomes null, leaving the ship on its present heading. */
  steerPt: { x: number; y: number } | null = null;
  /** For the one-time touch controls hint. */
  everSteered = false;

  private steerId: number | null = null; // identifier of the steering touch
  private tracked = new Map<number, TrackedTouch>();
  private fireRequested = false;
  private lastTapAt = -Infinity;
  private lastTapX = 0;
  private lastTapY = 0;

  /** Feed every canvas touch event. `w`/`h` are canvas CSS-pixel dimensions. */
  update(e: TouchEvent, canvas: HTMLCanvasElement, w: number, h: number, sub: boolean) {
    const rect = canvas.getBoundingClientRect();
    const sx = w / rect.width;
    const sy = h / rect.height;
    const point = (t: Touch) => ({
      x: (t.clientX - rect.left) * sx,
      y: (t.clientY - rect.top) * sy,
    });
    const now = performance.now();

    if (e.type === 'touchstart') {
      for (const t of Array.from(e.changedTouches)) {
        const p = point(t);
        this.tracked.set(t.identifier, {
          startX: p.x,
          startY: p.y,
          x: p.x,
          y: p.y,
          startedAt: now,
        });
        if (this.steerId === null) this.steerId = t.identifier;
      }
    }

    for (const t of Array.from(e.touches)) {
      const tracked = this.tracked.get(t.identifier);
      if (tracked) Object.assign(tracked, point(t));
    }

    if (e.type === 'touchend' || e.type === 'touchcancel') {
      for (const t of Array.from(e.changedTouches)) {
        const tracked = this.tracked.get(t.identifier);
        if (!tracked) continue;
        Object.assign(tracked, point(t));

        if (
          e.type === 'touchend' &&
          now - tracked.startedAt <= TAP_MAX_MS &&
          Math.hypot(tracked.x - tracked.startX, tracked.y - tracked.startY) <= TAP_MOVE_MAX
        ) {
          this.fireRequested = true;
          if (
            sub &&
            now - this.lastTapAt <= DOUBLE_TAP_MAX_MS &&
            Math.hypot(tracked.x - this.lastTapX, tracked.y - this.lastTapY) <=
              DOUBLE_TAP_DISTANCE
          ) {
            this.dive = !this.dive;
            this.lastTapAt = -Infinity; // a third tap starts a new pair
          } else {
            this.lastTapAt = now;
            this.lastTapX = tracked.x;
            this.lastTapY = tracked.y;
          }
        }

        this.tracked.delete(t.identifier);
        if (this.steerId === t.identifier) this.steerId = null;
      }
    }

    // If the helmsman lifts while another finger remains down, that finger
    // becomes the helm without requiring a fresh touch.
    if (this.steerId === null) this.steerId = this.tracked.keys().next().value ?? null;
    const steer = this.steerId === null ? undefined : this.tracked.get(this.steerId);
    this.steerPt = steer ? { x: steer.x, y: steer.y } : null;
    if (this.steerPt) this.everSteered = true;
  }

  /** Consume one or more taps since the previous frame as one trigger press.
   *  Reload rules still decide whether a shot can actually leave. */
  consumeFire(): boolean {
    const fire = this.fireRequested;
    this.fireRequested = false;
    return fire;
  }

  /** Forget all touch state (battle ended, session left). */
  reset() {
    this.dive = false;
    this.steerPt = null;
    this.steerId = null;
    this.tracked.clear();
    this.fireRequested = false;
    this.lastTapAt = -Infinity;
  }

  draw(ctx: CanvasRenderingContext2D, w: number, h: number, sub: boolean) {
    if (!this.everSteered) {
      // One-time hint until the first touch takes the helm.
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.font = '600 14px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(
        sub ? 'hold to steer · tap to fire · double-tap to dive' : 'hold to steer · tap to fire',
        w / 2,
        h - 24,
      );
    }
  }
}

// ── Mobile combat assists ────────────────────────────────────────────────────
const THREAT_HORIZON = 1.0; // s of shot flight considered for the warning
const THREAT_RADIUS = 55; // px — how near a passing shot must come to count

/** Bearings (world rad, from the ship) of shots that will pass within
 *  THREAT_RADIUS of it inside THREAT_HORIZON seconds. Your own shots exclude
 *  themselves naturally — they fly away from you, never closing. */
export function incomingThreats(
  me: { x: number; y: number },
  balls: Array<{ x: number; y: number; vx: number; vy: number }>,
  wrapW: number,
  wrapH: number,
): number[] {
  const out: number[] = [];
  for (const b of balls) {
    const dx = wrapDelta(me.x - b.x, wrapW);
    const dy = wrapDelta(me.y - b.y, wrapH);
    const v2 = b.vx * b.vx + b.vy * b.vy;
    if (v2 <= 0) continue;
    const t = (dx * b.vx + dy * b.vy) / v2; // time of closest approach
    if (t <= 0 || t > THREAT_HORIZON) continue;
    const ex = dx - b.vx * t;
    const ey = dy - b.vy * t;
    if (Math.hypot(ex, ey) > THREAT_RADIUS) continue;
    out.push(Math.atan2(-dy, -dx)); // bearing from the ship toward the shot
  }
  return out;
}

/** Red pulsing arc at the ship's rim pointing at an incoming shot — you can
 *  only dodge what you can see, and on a phone you otherwise can't see it. */
export function drawThreatArc(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  bearing: number,
) {
  const pulse = 0.5 + 0.3 * Math.sin(performance.now() / 90);
  ctx.strokeStyle = `rgba(255, 70, 70, ${pulse})`;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(x, y, r, bearing - 0.55, bearing + 0.55);
  ctx.stroke();
}
