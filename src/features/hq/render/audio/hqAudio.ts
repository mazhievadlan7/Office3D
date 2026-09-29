import type { Camera } from "three";
import { Vector3 } from "three";

/**
 * The HQ's own sounds, synthesised with Web Audio (no audio files): keyboards
 * and mice at the desks near the camera, and the android crew's muffled talk
 * where people chat. Everything is placed in 3D (HRTF panners) and heard from
 * the camera, so it only reaches the ear when the camera comes close.
 *
 * Browsers start audio only after a user gesture: `resume` is called on the
 * first pointer or key press. Nodes for one sound are made when it plays and
 * let go when it ends; the long-lived parts are a few panners and voices.
 */

/** Seconds of sound scheduled ahead of the audio clock each frame. */
const LOOKAHEAD = 0.12;
/** How loud the whole HQ is (0..1), before distance. */
const MASTER = 0.55;

/**
 * A source is re-placed only once it has moved this far (squared metres,
 * 1 cm) from where it was last placed: far below what HRTF panning can
 * resolve, and it spares an automation event per source per frame.
 */
const PLACE_EPSILON2 = 0.01 * 0.01;

/** The camera world-matrix elements the listener depends on (up, back, position). */
const LISTENER_ELEMENTS = [4, 5, 6, 8, 9, 10, 12, 13, 14] as const;

const _forward = new Vector3();
const _up = new Vector3();

export type HqAudioSource = {
  panner: PannerNode;
  /**
   * Moves the source (metres, world space). A move of 1 cm or less from the
   * last placed position is skipped (see PLACE_EPSILON2).
   */
  place(x: number, y: number, z: number): void;
  dispose(): void;
};

export class HqAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private enabled = true;
  private disposed = false;
  /** The listener as last applied (camera matrix elements), and to which context. */
  private readonly listenerAt = new Float64Array(16).fill(Number.NaN);
  private listenerCtx: AudioContext | null = null;

  /** The audio clock, or -1 before audio has started. */
  get now(): number {
    return this.ctx && this.ctx.state === "running" ? this.ctx.currentTime : -1;
  }

  /** Lookahead window end: sounds due before this are scheduled now. */
  get horizon(): number {
    const now = this.now;
    return now < 0 ? -1 : now + LOOKAHEAD;
  }

  get running(): boolean {
    return this.now >= 0 && this.enabled;
  }

  /** Starts (or wakes) the audio context; call from a user gesture. */
  resume(): void {
    if (this.disposed) return;
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      const master = ctx.createGain();
      master.gain.value = this.enabled ? MASTER : 0;
      // A gentle limiter so a burst of clicks never clips.
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -12;
      limiter.ratio.value = 6;
      master.connect(limiter);
      limiter.connect(ctx.destination);
      this.ctx = ctx;
      this.master = master;
      this.noise = whiteNoise(ctx, 1.5);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    const ctx = this.ctx;
    if (ctx && this.master) this.master.gain.setTargetAtTime(enabled ? MASTER : 0, ctx.currentTime, 0.08);
  }

  /**
   * The listener follows the camera. Only re-applied when the camera's world
   * matrix (its position or orientation) changed since the last call: the
   * listener keeps its values in between, so what is heard is the same.
   */
  setListener(camera: Camera): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const e = camera.matrixWorld.elements;
    const at = this.listenerAt;
    if (this.listenerCtx === ctx) {
      let same = true;
      for (let k = 0; k < LISTENER_ELEMENTS.length; k++) {
        const j = LISTENER_ELEMENTS[k];
        if (at[j] !== e[j]) {
          same = false;
          break;
        }
      }
      if (same) return;
    }
    this.listenerCtx = ctx;
    for (let k = 0; k < LISTENER_ELEMENTS.length; k++) {
      const j = LISTENER_ELEMENTS[k];
      at[j] = e[j];
    }
    const l = ctx.listener;
    _forward.set(-e[8], -e[9], -e[10]).normalize();
    _up.set(e[4], e[5], e[6]).normalize();
    if (l.positionX) {
      const t = ctx.currentTime;
      l.positionX.setValueAtTime(e[12], t);
      l.positionY.setValueAtTime(e[13], t);
      l.positionZ.setValueAtTime(e[14], t);
      l.forwardX.setValueAtTime(_forward.x, t);
      l.forwardY.setValueAtTime(_forward.y, t);
      l.forwardZ.setValueAtTime(_forward.z, t);
      l.upX.setValueAtTime(_up.x, t);
      l.upY.setValueAtTime(_up.y, t);
      l.upZ.setValueAtTime(_up.z, t);
    } else {
      // Older Safari.
      const legacy = l as unknown as {
        setPosition(x: number, y: number, z: number): void;
        setOrientation(x: number, y: number, z: number, ux: number, uy: number, uz: number): void;
      };
      legacy.setPosition(e[12], e[13], e[14]);
      legacy.setOrientation(_forward.x, _forward.y, _forward.z, _up.x, _up.y, _up.z);
    }
  }

  /** A positioned source; its sounds are connected to `panner`. */
  source(refDistance = 1.2, maxDistance = 22): HqAudioSource | null {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return null;
    const panner = ctx.createPanner();
    panner.panningModel = "HRTF";
    panner.distanceModel = "inverse";
    panner.refDistance = refDistance;
    panner.maxDistance = maxDistance;
    panner.rolloffFactor = 1.4;
    panner.connect(master);
    // Where the panner was last placed (NaN: never, so the first place applies).
    let atX = Number.NaN;
    let atY = Number.NaN;
    let atZ = Number.NaN;
    return {
      panner,
      place(x, y, z) {
        const dx = x - atX;
        const dy = y - atY;
        const dz = z - atZ;
        // Written so NaN (never placed) compares as "moved".
        if (dx * dx + dy * dy + dz * dz <= PLACE_EPSILON2) return;
        atX = x;
        atY = y;
        atZ = z;
        if (panner.positionX) {
          const t = ctx.currentTime;
          panner.positionX.setValueAtTime(x, t);
          panner.positionY.setValueAtTime(y, t);
          panner.positionZ.setValueAtTime(z, t);
        } else {
          (panner as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(x, y, z);
        }
      },
      dispose() {
        panner.disconnect();
      },
    };
  }

  /**
   * One key press at `time`: a short bright tick of filtered noise over a soft
   * low thock, like a mechanical switch bottoming out. `heavy` is the space
   * bar or Enter.
   */
  keyClick(out: AudioNode, time: number, level: number, pitch: number, heavy: boolean): void {
    const ctx = this.ctx;
    const noise = this.noise;
    if (!ctx || !noise) return;
    const tick = ctx.createBufferSource();
    tick.buffer = noise;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = (heavy ? 1400 : 2600) * pitch;
    band.Q.value = heavy ? 0.9 : 1.4;
    const env = ctx.createGain();
    const peak = level * (heavy ? 0.55 : 0.42);
    const decay = heavy ? 0.05 : 0.028;
    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(peak, time + 0.0012);
    env.gain.exponentialRampToValueAtTime(0.0005, time + decay);
    tick.connect(band);
    band.connect(env);
    env.connect(out);
    tick.start(time, Math.random() * (noise.duration - 0.2), decay + 0.02);

    const thock = ctx.createOscillator();
    thock.type = "sine";
    thock.frequency.setValueAtTime((heavy ? 120 : 190) * pitch, time);
    thock.frequency.exponentialRampToValueAtTime((heavy ? 70 : 110) * pitch, time + 0.03);
    const body = ctx.createGain();
    body.gain.setValueAtTime(0, time);
    body.gain.linearRampToValueAtTime(level * (heavy ? 0.35 : 0.18), time + 0.002);
    body.gain.exponentialRampToValueAtTime(0.0005, time + (heavy ? 0.07 : 0.04));
    thock.connect(body);
    body.connect(out);
    thock.start(time);
    thock.stop(time + 0.09);
  }

  /** A mouse button: a crisp, higher double tick (press and release). */
  mouseClick(out: AudioNode, time: number, level: number): void {
    const ctx = this.ctx;
    const noise = this.noise;
    if (!ctx || !noise) return;
    // The release's delay is drawn before either tick, as it always was.
    const release = 0.07 + Math.random() * 0.03;
    mouseTick(ctx, noise, out, time, level, 1);
    mouseTick(ctx, noise, out, time + release, level, 0.55);
  }

  /**
   * A muffled android voice: a buzzing glottal tone through two moving
   * formants and a syllable envelope. Returns controls to shape it, or null
   * before audio has started.
   */
  voice(out: AudioNode, pitch: number): HqVoice | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = pitch;
    // A little vibrato so it never sounds like a test tone.
    const vib = ctx.createOscillator();
    vib.frequency.value = 5.2;
    const vibDepth = ctx.createGain();
    vibDepth.gain.value = pitch * 0.02;
    vib.connect(vibDepth);
    vibDepth.connect(osc.frequency);
    const f1 = ctx.createBiquadFilter();
    f1.type = "bandpass";
    f1.Q.value = 6;
    f1.frequency.value = 600;
    const f2 = ctx.createBiquadFilter();
    f2.type = "bandpass";
    f2.Q.value = 8;
    f2.frequency.value = 1500;
    const mix = ctx.createGain();
    mix.gain.value = 1;
    const muffle = ctx.createBiquadFilter();
    muffle.type = "lowpass";
    muffle.frequency.value = 2400;
    const env = ctx.createGain();
    env.gain.value = 0;
    osc.connect(f1);
    osc.connect(f2);
    f1.connect(mix);
    f2.connect(mix);
    mix.connect(muffle);
    muffle.connect(env);
    env.connect(out);
    osc.start();
    vib.start();
    return {
      syllable(time, length, level, vowel) {
        const formants = VOWELS[vowel % VOWELS.length];
        f1.frequency.setTargetAtTime(formants[0], time, 0.02);
        f2.frequency.setTargetAtTime(formants[1], time, 0.02);
        osc.frequency.setTargetAtTime(pitch * (0.92 + Math.random() * 0.16), time, 0.04);
        env.gain.setTargetAtTime(level * 0.9, time, 0.015);
        env.gain.setTargetAtTime(0, time + length * 0.75, 0.03);
      },
      stop(time) {
        env.gain.setTargetAtTime(0, time, 0.05);
        osc.stop(time + 0.4);
        vib.stop(time + 0.4);
        window.setTimeout(() => {
          for (const node of [osc, vib, vibDepth, f1, f2, mix, muffle, env]) node.disconnect();
        }, 800);
      },
    };
  }

  dispose(): void {
    this.disposed = true;
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
    this.noise = null;
  }
}

export type HqVoice = {
  /** One syllable from `time` for `length` seconds, at `level` (0..1), on a vowel index. */
  syllable(time: number, length: number, level: number, vowel: number): void;
  stop(time: number): void;
};

/** Formant pairs (F1, F2, Hz) of the Russian vowels а, о, у, э, и, ы. */
const VOWELS: ReadonlyArray<readonly [number, number]> = [
  [750, 1300],
  [550, 900],
  [320, 750],
  [550, 1750],
  [300, 2200],
  [330, 1500],
];

/** One tick of a mouse button at `t`: high-passed noise, `gain` of a full click. */
function mouseTick(ctx: AudioContext, noise: AudioBuffer, out: AudioNode, t: number, level: number, gain: number): void {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 3800;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(level * 0.3 * gain, t + 0.0008);
  env.gain.exponentialRampToValueAtTime(0.0005, t + 0.015);
  src.connect(hp);
  hp.connect(env);
  env.connect(out);
  src.start(t, Math.random() * (noise.duration - 0.1), 0.03);
}

function whiteNoise(ctx: AudioContext, seconds: number): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}
