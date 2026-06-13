import { angleDiff } from './ai';

const DRIFT_MAX = 0.12; // rad/s; cap on how fast the wind can swing
const DRIFT_WANDER = 0.3; // rad/s per s; random walk applied to the drift rate

export class Wind {
  direction = Math.random() * Math.PI * 2; // radians; where the wind blows toward

  private drift = 0;

  /** The wind slowly wanders during a battle so positioning stays interesting. */
  update(dt: number) {
    this.drift += (Math.random() - 0.5) * DRIFT_WANDER * dt;
    this.drift = Math.max(-DRIFT_MAX, Math.min(DRIFT_MAX, this.drift));
    this.direction += this.drift * dt;
  }

  /**
   * Speed multiplier for a hull heading. Asymmetric point-of-sail curve:
   * 0.4 beating straight into the wind, 1.0 beam-on (perpendicular), 0.85
   * running dead downwind, peaking ~1.05 on a broad reach in between.
   */
  speedFactor(heading: number): number {
    const offDownwind = Math.abs(angleDiff(heading, this.direction));
    return 0.625 + 0.225 * Math.cos(offDownwind) + 0.375 * Math.sin(offDownwind);
  }
}
