// Shared on-screen touch controls: a floating steer stick, a fire button, and
// (for submarines) a dive toggle. Used by both practice battles (game.ts) and
// multiplayer (multiplayer.ts) so the two modes feel identical under thumbs.

export interface BtnRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** True when the device plausibly has a touchscreen. `maxTouchPoints` alone
 *  reports 0 in some Android WebViews (chat-app in-app browsers, where invite
 *  links usually open) and in "request desktop site" mode, so several signals
 *  are consulted — and callers additionally upgrade at runtime on the first
 *  real touch event, which is proof positive. */
export function touchCapable(): boolean {
  if (navigator.maxTouchPoints > 0 || 'ontouchstart' in window) return true;
  return window.matchMedia?.('(any-pointer: coarse)').matches ?? false;
}

// iOS home-indicator / notch inset in px, exposed by style.css as --safe-bottom
// (env() is CSS-only). Without it the bottom button row sits in the swipe-up
// gesture zone. Rotation changes the inset, so re-read on resize.
let safeBottom = 0;
function readSafeBottom() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--safe-bottom');
  safeBottom = parseFloat(v) || 0;
}
readSafeBottom();
// The stylesheet defining --safe-bottom may not be applied yet when this
// module first runs (prod loads CSS via <link>), so read again after load.
window.addEventListener('load', readSafeBottom);
window.addEventListener('resize', readSafeBottom);

// Large enough for thumbs.
export const BTN_SIZE = 72;
export const BTN_MARGIN = 24;

const TURN_DEADZONE = 0.12; // rad — stop turning when close enough to the course

/** Tap-to-sail: how close (world px) the ship must pass to a set course point
 *  before it counts as reached. Slightly over the widest turning circle
 *  (small ship ≈ 72 px) so a near miss doesn't become an endless orbit. */
export const ARRIVE_RADIUS = 85;

/** Which way to turn to reach `desired`, re-evaluated per frame against the
 *  current heading so the ship settles on course instead of oscillating. */
export function turnToward(desired: number, heading: number): -1 | 0 | 1 {
  let d = desired - heading;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  if (Math.abs(d) < TURN_DEADZONE) return 0;
  return d > 0 ? 1 : -1;
}

export interface TouchButtons {
  fire: BtnRect;
  dive: BtnRect; // only drawn/used when your ship is a submarine
}

/** Fire under the right thumb; dive stacked above it. Steering has no fixed
 *  rect — the stick anchors wherever the other thumb lands. */
export function layoutTouchButtons(w: number, h: number): TouchButtons {
  const by = h - BTN_MARGIN - BTN_SIZE - safeBottom;
  return {
    fire: { x: w - BTN_MARGIN - BTN_SIZE, y: by, w: BTN_SIZE, h: BTN_SIZE },
    dive: { x: w - BTN_MARGIN - BTN_SIZE, y: by - BTN_SIZE - 12, w: BTN_SIZE, h: BTN_SIZE },
  };
}

// Thumbs are blunt and eyes are on the battle, so touches count a bit beyond
// the drawn edge.
const HIT_PADDING = 16;

export function hitBtn(btn: BtnRect, tx: number, ty: number): boolean {
  return (
    tx >= btn.x - HIT_PADDING &&
    tx <= btn.x + btn.w + HIT_PADDING &&
    ty >= btn.y - HIT_PADDING &&
    ty <= btn.y + btn.h + HIT_PADDING
  );
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

export function drawTouchBtn(
  ctx: CanvasRenderingContext2D,
  btn: BtnRect,
  label: string,
  active: boolean,
) {
  ctx.fillStyle = active ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.35)';
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(btn.x, btn.y, btn.w, btn.h, 14);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#fff';
  ctx.font = 'bold 28px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, btn.x + btn.w / 2, btn.y + btn.h / 2);
}

/** Tap-to-sail: tap (or hold) anywhere off the buttons and the game sets a
 *  course buoy there — the ship steers itself to it and sails on through.
 *  This class only tracks fingers; the buoy lives in world space and belongs
 *  to the game, which converts `steerPt` through its own camera. Fire is
 *  press-and-hold; dive is a tap toggle so submariners don't hold a finger. */
export class TouchControls {
  /** True while a finger is on the fire button. */
  fire = false;
  /** Dive toggle state — tap flips it; the game surfaces the sub when the
   *  charge runs out, but the toggle stays until tapped off. */
  dive = false;
  /** Screen position (canvas CSS px) of the steering finger while it is down,
   *  null once lifted. While non-null the game keeps re-aiming at it. */
  steerPt: { x: number; y: number } | null = null;
  /** For the idle "tap the sea" hint — true after the first course is set. */
  everSteered = false;

  private steerId: number | null = null; // identifier of the steering touch
  private diveHeld = false; // edge detector for the toggle

  /** Feed every canvas touch event. `w`/`h` are canvas CSS-pixel dimensions. */
  update(e: TouchEvent, canvas: HTMLCanvasElement, w: number, h: number, sub: boolean) {
    const rect = canvas.getBoundingClientRect();
    const sx = w / rect.width;
    const sy = h / rect.height;
    const btns = layoutTouchButtons(w, h);

    let fire = false;
    let diveHit = false;
    let steer: { x: number; y: number } | null = null;
    let claim: { id: number; x: number; y: number } | null = null;
    for (const t of Array.from(e.touches)) {
      const tx = (t.clientX - rect.left) * sx;
      const ty = (t.clientY - rect.top) * sy;
      // The steering finger stays the steering finger even if it wanders over
      // a button; only new touches are hit-tested against the buttons.
      if (t.identifier === this.steerId) steer = { x: tx, y: ty };
      else if (hitBtn(btns.fire, tx, ty)) fire = true;
      else if (sub && hitBtn(btns.dive, tx, ty)) diveHit = true;
      else if (claim === null) claim = { id: t.identifier, x: tx, y: ty };
    }

    if (steer === null && claim !== null) {
      this.steerId = claim.id;
      steer = { x: claim.x, y: claim.y };
    }
    if (steer === null) this.steerId = null;
    else this.everSteered = true;
    this.steerPt = steer;

    this.fire = fire;
    if (diveHit && !this.diveHeld) this.dive = !this.dive;
    this.diveHeld = diveHit;
  }

  /** Forget all touch state (battle ended, session left). */
  reset() {
    this.fire = false;
    this.dive = false;
    this.steerPt = null;
    this.steerId = null;
    this.diveHeld = false;
  }

  /** `charge` is the submarine dive charge 0..1, shown as a fill in the dive
   *  button so the player sees how much air is left without a separate HUD. */
  draw(ctx: CanvasRenderingContext2D, w: number, h: number, sub: boolean, charge = 1) {
    const btns = layoutTouchButtons(w, h);
    drawTouchBtn(ctx, btns.fire, '🔥', this.fire);
    if (sub) {
      drawTouchBtn(ctx, btns.dive, '🤿', this.dive);
      const d = btns.dive;
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(d.x, d.y, d.w, d.h, 14);
      ctx.clip();
      ctx.fillStyle = 'rgba(79, 216, 239, 0.35)';
      const fh = d.h * Math.max(0, Math.min(1, charge));
      ctx.fillRect(d.x, d.y + d.h - fh, d.w, fh);
      ctx.restore();
    }

    if (!this.everSteered) {
      // One-time hint until the first course is set.
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.font = '600 14px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText('👆 tap the sea to set course', w / 2, h - BTN_MARGIN - safeBottom - 6);
    }
  }
}

/** The course buoy: a gold marker with a pulsing ring, drawn by the game in
 *  screen space wherever the current tap-to-sail target sits. */
export function drawBuoy(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const pulse = 10 + 3 * Math.sin(performance.now() / 180);
  ctx.strokeStyle = 'rgba(255, 210, 63, 0.55)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, pulse, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#ffd23f';
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}
