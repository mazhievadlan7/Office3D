import { afterEach, describe, expect, it, vi } from "vitest";
import { PerspectiveCamera } from "three";

import { HqAudio } from "@/features/hq/render/audio/hqAudio";
import { indexOfId, type IdIndex } from "@/features/hq/render/audio/HqSoundscape";

/** A Web Audio stand-in that records what is scheduled. */
type Call = [string, ...number[]];

class FakeParam {
  value = 0;
  readonly calls: Call[] = [];
  setValueAtTime(v: number, t: number) {
    this.calls.push(["set", v, t]);
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.calls.push(["linear", v, t]);
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    this.calls.push(["exp", v, t]);
  }
  setTargetAtTime(v: number, t: number, k: number) {
    this.calls.push(["target", v, t, k]);
  }
}

class FakeNode {
  connect(to: unknown) {
    return to;
  }
  disconnect() {}
}

class FakeGain extends FakeNode {
  readonly gain = new FakeParam();
}

class FakeFilter extends FakeNode {
  type = "";
  readonly frequency = new FakeParam();
  readonly Q = new FakeParam();
}

class FakeBufferSource extends FakeNode {
  buffer: unknown = null;
  readonly starts: number[][] = [];
  start(...args: number[]) {
    this.starts.push(args);
  }
}

class FakeOscillator extends FakeNode {
  type = "";
  readonly frequency = new FakeParam();
  start() {}
  stop() {}
}

class FakePanner extends FakeNode {
  panningModel = "";
  distanceModel = "";
  refDistance = 0;
  maxDistance = 0;
  rolloffFactor = 0;
  readonly positionX = new FakeParam();
  readonly positionY = new FakeParam();
  readonly positionZ = new FakeParam();
}

class FakeContext {
  static last: FakeContext | null = null;
  state = "running";
  currentTime = 1;
  sampleRate = 1000;
  readonly destination = new FakeNode();
  readonly gains: FakeGain[] = [];
  readonly filters: FakeFilter[] = [];
  readonly sources: FakeBufferSource[] = [];
  readonly listener = {
    positionX: new FakeParam(),
    positionY: new FakeParam(),
    positionZ: new FakeParam(),
    forwardX: new FakeParam(),
    forwardY: new FakeParam(),
    forwardZ: new FakeParam(),
    upX: new FakeParam(),
    upY: new FakeParam(),
    upZ: new FakeParam(),
  };
  constructor() {
    FakeContext.last = this;
  }
  createGain() {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  createDynamicsCompressor() {
    return Object.assign(new FakeNode(), { threshold: new FakeParam(), ratio: new FakeParam() });
  }
  createBuffer(_channels: number, length: number, rate: number) {
    return { duration: length / rate, getChannelData: () => new Float32Array(length) };
  }
  createPanner() {
    return new FakePanner();
  }
  createBufferSource() {
    const s = new FakeBufferSource();
    this.sources.push(s);
    return s;
  }
  createBiquadFilter() {
    const f = new FakeFilter();
    this.filters.push(f);
    return f;
  }
  createOscillator() {
    return new FakeOscillator();
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}

function startAudio(): { audio: HqAudio; ctx: FakeContext } {
  vi.stubGlobal("AudioContext", FakeContext);
  const audio = new HqAudio();
  audio.resume();
  const ctx = FakeContext.last;
  if (!ctx) throw new Error("no context");
  return { audio, ctx };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  FakeContext.last = null;
});

describe("HqAudio sources", () => {
  it("places a source on its first call and again only after it moved more than 1 cm", () => {
    const { audio } = startAudio();
    const src = audio.source(1.1, 19);
    if (!src) throw new Error("no source");
    const panner = src.panner as unknown as FakePanner;
    src.place(2, 0.77, 3);
    expect(panner.positionX.calls).toEqual([["set", 2, 1]]);
    expect(panner.positionY.calls).toEqual([["set", 0.77, 1]]);
    expect(panner.positionZ.calls).toEqual([["set", 3, 1]]);
    // Standing still (a seated typist): nothing new is scheduled.
    src.place(2, 0.77, 3);
    src.place(2.005, 0.77, 3.005);
    expect(panner.positionX.calls).toHaveLength(1);
    // Past 1 cm from the last placed position: moved.
    src.place(2.02, 0.77, 3);
    expect(panner.positionX.calls).toEqual([
      ["set", 2, 1],
      ["set", 2.02, 1],
    ]);
    expect(panner.positionZ.calls[1]).toEqual(["set", 3, 1]);
  });
});

describe("soundscape id index", () => {
  it("answers exactly like ids.indexOf and rebuilds only for a new roster array", () => {
    const cache: IdIndex = { ids: null, index: new Map() };
    const roster = ["a", "b", "a", "c"];
    for (const id of ["a", "b", "c", "zz"]) expect(indexOfId(cache, roster, id)).toBe(roster.indexOf(id));
    const built = cache.index;
    const sizeBefore = built.size;
    // Same array again: no rebuild.
    expect(indexOfId(cache, roster, "c")).toBe(3);
    expect(cache.ids).toBe(roster);
    expect(built.size).toBe(sizeBefore);
    // A new roster (the sim replaces frame.ids): the old ids are gone, the new ones found.
    const next = ["c", "d"];
    expect(indexOfId(cache, next, "a")).toBe(-1);
    expect(indexOfId(cache, next, "c")).toBe(0);
    expect(indexOfId(cache, next, "d")).toBe(1);
    expect(cache.ids).toBe(next);
    expect(cache.index.size).toBe(2);
  });
});

describe("HqAudio listener", () => {
  it("follows the camera and skips frames where the camera did not move", () => {
    const { audio, ctx } = startAudio();
    const camera = new PerspectiveCamera();
    camera.position.set(4, 6, 8);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    audio.setListener(camera);
    const l = ctx.listener;
    expect(l.positionX.calls).toEqual([["set", 4, 1]]);
    expect(l.positionY.calls).toEqual([["set", 6, 1]]);
    expect(l.positionZ.calls).toEqual([["set", 8, 1]]);
    const len = Math.hypot(4, 6, 8);
    expect(l.forwardX.calls[0][1]).toBeCloseTo(-4 / len, 6);
    expect(l.forwardY.calls[0][1]).toBeCloseTo(-6 / len, 6);
    expect(l.forwardZ.calls[0][1]).toBeCloseTo(-8 / len, 6);

    ctx.currentTime = 2;
    audio.setListener(camera);
    expect(l.positionX.calls).toHaveLength(1);
    expect(l.upY.calls).toHaveLength(1);

    // Turning in place changes the orientation only: re-applied.
    camera.lookAt(1, 0, 0);
    camera.updateMatrixWorld();
    audio.setListener(camera);
    expect(l.positionX.calls).toEqual([
      ["set", 4, 1],
      ["set", 4, 2],
    ]);
    expect(l.forwardX.calls).toHaveLength(2);

    // Moving: re-applied.
    ctx.currentTime = 3;
    camera.position.set(5, 6, 8);
    camera.updateMatrixWorld();
    audio.setListener(camera);
    expect(l.positionX.calls[2]).toEqual(["set", 5, 3]);
  });
});

describe("HqAudio clicks", () => {
  it("schedules a mouse click as a press and a release tick, drawing randomness in the same order", () => {
    const { audio, ctx } = startAudio();
    const out = new FakeNode() as unknown as AudioNode;
    const draws = [0.5, 0.25, 0.75];
    vi.spyOn(Math, "random").mockImplementation(() => draws.shift() ?? 0);
    const sourcesBefore = ctx.sources.length;
    const gainsBefore = ctx.gains.length;
    audio.mouseClick(out, 10, 0.8);
    const sources = ctx.sources.slice(sourcesBefore);
    const gains = ctx.gains.slice(gainsBefore);
    expect(sources).toHaveLength(2);
    expect(gains).toHaveLength(2);
    // First draw: the release delay; then each tick's offset into the noise.
    const release = 0.07 + 0.5 * 0.03;
    const noiseSpan = 1.5 - 0.1;
    expect(sources[0].starts).toEqual([[10, 0.25 * noiseSpan, 0.03]]);
    expect(sources[1].starts).toEqual([[10 + release, 0.75 * noiseSpan, 0.03]]);
    expect(gains[0].gain.calls).toEqual([
      ["set", 0, 10],
      ["linear", 0.8 * 0.3 * 1, 10 + 0.0008],
      ["exp", 0.0005, 10 + 0.015],
    ]);
    const t = 10 + release;
    expect(gains[1].gain.calls).toEqual([
      ["set", 0, t],
      ["linear", 0.8 * 0.3 * 0.55, t + 0.0008],
      ["exp", 0.0005, t + 0.015],
    ]);
    for (const f of ctx.filters.slice(-2)) {
      expect(f.type).toBe("highpass");
      expect(f.frequency.value).toBe(3800);
    }
  });

  it("moves a voice's formants to the syllable's vowel", () => {
    const { audio, ctx } = startAudio();
    const filtersBefore = ctx.filters.length;
    const voice = audio.voice(new FakeNode() as unknown as AudioNode, 120);
    if (!voice) throw new Error("no voice");
    const [f1, f2] = ctx.filters.slice(filtersBefore);
    voice.syllable(5, 0.2, 0.3, 4 + 6); // wraps round to и
    expect(f1.frequency.calls).toEqual([["target", 300, 5, 0.02]]);
    expect(f2.frequency.calls).toEqual([["target", 2200, 5, 0.02]]);
  });
});
