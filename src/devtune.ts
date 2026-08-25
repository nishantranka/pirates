/**
 * DEV-ONLY tuning knob, exposed as `window.__devTune` in development builds
 * (see main.ts) and never written by the shipped game — so in production the
 * value stays pinned at 1 and the read in Ship.update is a no-op multiply.
 *
 * Game *pace* is a real player setting now (the settings modal). This is the
 * other lever, kept for design work: it scales hull movement while leaving
 * shot flight and reload cadence at full rate, so unlike pace it genuinely
 * re-balances the game — you cover less water per reload, which makes lining
 * up a broadside easier. That's a design call to make deliberately, not
 * something to hand a player, which is why it has no UI.
 */
export const devTune = {
  shipSpeed: 1,
};
