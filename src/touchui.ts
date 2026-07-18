// Shared on-screen touch controls for touch devices: button layout, hit
// testing, and drawing. Used by both practice battles (game.ts) and
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

export interface TouchButtons {
  left: BtnRect;
  right: BtnRect;
  fire: BtnRect;
  dive: BtnRect; // only drawn/used when your ship is a submarine
}

/** Steering in the bottom corners, fire bottom-center, dive stacked above fire. */
export function layoutTouchButtons(w: number, h: number): TouchButtons {
  const by = h - BTN_MARGIN - BTN_SIZE - safeBottom;
  return {
    left: { x: BTN_MARGIN, y: by, w: BTN_SIZE, h: BTN_SIZE },
    right: { x: w - BTN_MARGIN - BTN_SIZE, y: by, w: BTN_SIZE, h: BTN_SIZE },
    fire: { x: w / 2 - BTN_SIZE / 2, y: by, w: BTN_SIZE, h: BTN_SIZE },
    dive: { x: w / 2 - BTN_SIZE / 2, y: by - BTN_SIZE - 12, w: BTN_SIZE, h: BTN_SIZE },
  };
}

export function hitBtn(btn: BtnRect, tx: number, ty: number): boolean {
  return tx >= btn.x && tx <= btn.x + btn.w && ty >= btn.y && ty <= btn.y + btn.h;
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
