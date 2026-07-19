// The game's soundscape: "8-bit Arcade" (option 2 from the Sound Lab
// playtest) — chiptune squares, saws and noise zaps, fully synthesized with
// WebAudio. No audio files: smaller bundle, unlimited overlap, and cues can
// be re-pitched in code later. The AudioContext is created lazily on the
// first cue, which always happens after a user gesture (starting a battle).

// Every cue is strictly first-person — with 20 captains at sea, other people's
// shots, misses and sinkings are just noise. You hear only what YOU did or
// what happened TO you, and the kill fanfare is the loudest, proudest cue.
export interface GameSounds {
  fire(): void; // you fired
  myHit(): void; // your shot/ram landed on someone
  getHit(): void; // you took a hit
  pickup(): void; // you grabbed a power-up
  kill(): void; // you sank someone — the reward cue
  sunk(): void; // YOUR ship went down
}

export function createSounds(isMuted: () => boolean): GameSounds {
  let ac: AudioContext | null = null;
  let master: GainNode | null = null;

  function ctx(): AudioContext {
    if (!ac) {
      type W = Window & { webkitAudioContext?: typeof AudioContext };
      const AC = window.AudioContext ?? (window as W).webkitAudioContext!;
      ac = new AC();
      master = ac.createGain();
      master.gain.value = 0.5;
      master.connect(ac.destination);
    }
    if (ac.state === 'suspended') void ac.resume();
    return ac;
  }

  /** One oscillator with a pitch glide and exponential decay. */
  function tone(opts: { type?: OscillatorType; f0: number; f1?: number; dur: number; vol: number; at?: number }) {
    const a = ctx();
    const t = a.currentTime + (opts.at ?? 0);
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = opts.type ?? 'sine';
    o.frequency.setValueAtTime(opts.f0, t);
    if (opts.f1 !== undefined) o.frequency.exponentialRampToValueAtTime(Math.max(opts.f1, 1), t + opts.dur);
    g.gain.setValueAtTime(opts.vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + opts.dur);
    o.connect(g);
    g.connect(master!);
    o.start(t);
    o.stop(t + opts.dur + 0.02);
  }

  /** Filtered white-noise burst with decay. */
  function burst(opts: { dur: number; type?: BiquadFilterType; f0: number; f1?: number; vol: number; at?: number }) {
    const a = ctx();
    const t = a.currentTime + (opts.at ?? 0);
    const len = Math.ceil(a.sampleRate * opts.dur);
    const buf = a.createBuffer(1, len, a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = a.createBufferSource();
    src.buffer = buf;
    const f = a.createBiquadFilter();
    f.type = opts.type ?? 'lowpass';
    f.frequency.setValueAtTime(opts.f0, t);
    if (opts.f1 !== undefined) f.frequency.exponentialRampToValueAtTime(Math.max(opts.f1, 10), t + opts.dur);
    const g = a.createGain();
    g.gain.setValueAtTime(opts.vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + opts.dur);
    src.connect(f);
    f.connect(g);
    g.connect(master!);
    src.start(t);
  }

  return {
    // Firing is the most frequent cue, so it sits a notch under the lab level.
    fire() {
      if (isMuted()) return;
      tone({ type: 'square', f0: 240, f1: 90, dur: 0.14, vol: 0.28 });
    },
    myHit() {
      if (isMuted()) return;
      tone({ type: 'square', f0: 480, f1: 220, dur: 0.12, vol: 0.35 });
      burst({ dur: 0.08, type: 'highpass', f0: 1500, vol: 0.3, at: 0.02 });
    },
    getHit() {
      if (isMuted()) return;
      tone({ type: 'sawtooth', f0: 170, f1: 55, dur: 0.28, vol: 0.5 });
      burst({ dur: 0.2, f0: 900, f1: 200, vol: 0.4 });
    },
    pickup() {
      if (isMuted()) return;
      [660, 880, 1320].forEach((f, i) => tone({ type: 'square', f0: f, dur: 0.07, vol: 0.22, at: i * 0.06 }));
    },
    // The star of the set: a quick rising victory arpeggio with a sparkle tail.
    kill() {
      if (isMuted()) return;
      [392, 523, 659, 784].forEach((f, i) => tone({ type: 'square', f0: f, dur: 0.09, vol: 0.3, at: i * 0.07 }));
      burst({ dur: 0.25, type: 'highpass', f0: 1800, vol: 0.2, at: 0.28 });
    },
    sunk() {
      if (isMuted()) return;
      tone({ type: 'square', f0: 420, f1: 45, dur: 0.7, vol: 0.4 });
    },
  };
}
