/**
 * DEV-ONLY tuning knob, driven by the panel main.ts mounts under
 * `import.meta.env.DEV`. Nothing in the shipped game writes it — the panel is
 * the only writer and it never mounts in a production build, so the value
 * stays pinned at 1 and the read in Ship.update is a no-op multiply.
 *
 * Game *pace* is a real player setting now (see the settings modal); this is
 * the other lever, kept for design work only. It scales hull movement while
 * leaving shot flight and reload cadence at full rate, so it re-balances the
 * game rather than just slowing it down — a design call, not a preference.
 */
export const devTune = {
  shipSpeed: 1,
};
