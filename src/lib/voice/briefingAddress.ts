/**
 * AM7's briefing over the hall's public address: his answer said sentence by
 * sentence in his own voice (voicestudio:am7 through /api/office/voice/reply,
 * its humanoid treatment already applied by the speech gateway), played
 * through a PA chain so it carries across the whole hall whatever the camera
 * does: not placed in 3D, no distance falloff (the crew's talk fades out past
 * ~18 m; this does not).
 *
 * The chain is a microphone into a hall's loudspeakers, kept subtle:
 *   high-pass (no rumble) -> a small cut in the mud, a lift in the presence
 *   band -> gentle compression and make-up gain (loud and even) -> the dry
 *   voice, plus a short slap-back off the far wall and a short hall reverb
 *   -> a limiter, so nothing clips.
 * While it plays the HQ's crew talk and keyboards duck hard (speechDuck "pa").
 *
 * Every sentence is one request. They are rendered as soon as the answer is
 * known (prepareBriefingAddress), one after another (the speech service
 * renders one line at a time and answers "busy" to a second), while the floor
 * is still gathering; AM7 begins once at least the first two are rendered and,
 * at the observed rendering pace, the rest will be ready before they are due
 * (canStartAddress). The sentences are then scheduled back to back on the
 * audio clock, a 0.3 s breath apart. Each is reported as it actually starts
 * and ends playing (onCueStart / onCueEnd): the video wall and AM7's gestures
 * follow the audio, not a timer. Only a sentence whose audio could not be had
 * is held for its reading time, so the wall still moves on.
 *
 * Audio unlock: browsers keep an audio context suspended until a user
 * gesture. The shared speech context (systemVoice) is primed on the first
 * click or key press; if it is still locked when AM7 begins, the speech waits
 * (onLocked) and plays from the start at the next click or key press.
 */

import { beginForegroundSpeech } from "./speechDuck";
import { speechAudioContext, whenRunning } from "./systemVoice";

/** The breath between two sentences on the PA (seconds). */
const SENTENCE_GAP_S = 0.3;
/** Reading time for a sentence with no audio (ms per character, and the least). */
const SILENT_MS_PER_CHAR = 62;
const SILENT_MIN_MS = 1400;

export type BriefingAddressEvents = {
  /** Sentence `index` has started playing (its audio is heard from now). */
  onCueStart?: (index: number) => void;
  /** Sentence `index` has finished playing. */
  onCueEnd?: (index: number) => void;
  /** The audio context is locked: the speech waits for the next click or key press. */
  onLocked?: () => void;
  /** The audio context runs (at once, or after the gesture). */
  onUnlocked?: () => void;
};

export type BriefingAddressOptions = {
  voiceId?: string | null;
  speed?: number;
  /** Stop waiting for a gesture after this long (ms); the speech is then skipped. */
  gestureTimeoutMs?: number;
  /** false: fetch nothing, play nothing, only walk the cues at reading pace (the HQ's sound is off). */
  audible?: boolean;
};

export type BriefingAddress = {
  /** Resolves when the last sentence has ended (true if anything was heard). */
  done: Promise<boolean>;
  /** Stops at once: the sentence playing is cut, nothing more is fetched or reported. */
  stop(): void;
};

type PaChain = { input: GainNode; nodes: Record<string, AudioNode> };

const chains = new WeakMap<BaseAudioContext, PaChain>();

/** A short, bright hall: a few early reflections and a ~1 s exponential tail, stereo. */
export function hallImpulse(sampleRate: number, seconds = 1.1): [Float32Array, Float32Array] {
  const length = Math.max(1, Math.floor(sampleRate * seconds));
  const channels: [Float32Array, Float32Array] = [new Float32Array(length), new Float32Array(length)];
  const early = [0.011, 0.019, 0.027, 0.041, 0.053];
  channels.forEach((data, ch) => {
    let seed = 1234567 + ch * 7654321;
    const rand = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 0x100000000 - 0.5;
    };
    let smooth = 0;
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      // A little low-pass on the noise: the far walls give back less top.
      smooth = smooth * 0.55 + rand() * 0.45;
      data[i] = t < 0.012 ? 0 : smooth * Math.exp(-t * 5.2) * 0.9;
    }
    for (const [k, at] of early.entries()) {
      const i = Math.floor((at + ch * 0.0017 * (k + 1)) * sampleRate);
      if (i < length) data[i] += (k % 2 ? -1 : 1) * 0.42 * Math.exp(-at * 18);
    }
  });
  return channels;
}

/** The PA chain on `ctx` (built once per context); speech goes into `input`. */
function paChain(ctx: AudioContext): PaChain {
  const existing = chains.get(ctx);
  if (existing) return existing;
  const input = ctx.createGain();
  input.gain.value = 1;
  const highpass = ctx.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = 115;
  highpass.Q.value = 0.7;
  const mud = ctx.createBiquadFilter();
  mud.type = "peaking";
  mud.frequency.value = 260;
  mud.Q.value = 1;
  mud.gain.value = -2.5;
  const presence = ctx.createBiquadFilter();
  presence.type = "peaking";
  presence.frequency.value = 3000;
  presence.Q.value = 0.9;
  presence.gain.value = 3.5;
  const air = ctx.createBiquadFilter();
  air.type = "lowpass";
  air.frequency.value = 9500;
  air.Q.value = 0.5;
  const compressor = ctx.createDynamicsCompressor();
  // Gentle: the gateway's audio is already hot, so a few dB off the peaks at most.
  compressor.threshold.value = -16;
  compressor.knee.value = 12;
  compressor.ratio.value = 2.2;
  compressor.attack.value = 0.006;
  compressor.release.value = 0.22;
  const makeup = ctx.createGain();
  makeup.gain.value = 1.45;
  const out = ctx.createGain();
  out.gain.value = 1;
  // The far wall's slap-back: one short, darker echo.
  const slap = ctx.createDelay(0.5);
  slap.delayTime.value = 0.085;
  const slapTone = ctx.createBiquadFilter();
  slapTone.type = "lowpass";
  slapTone.frequency.value = 3200;
  const slapLevel = ctx.createGain();
  slapLevel.gain.value = 0.16;
  // The hall: a short reverb under the voice.
  const hall = ctx.createConvolver();
  const [left, right] = hallImpulse(ctx.sampleRate);
  const impulse = ctx.createBuffer(2, left.length, ctx.sampleRate);
  impulse.copyToChannel(left as Float32Array<ArrayBuffer>, 0);
  impulse.copyToChannel(right as Float32Array<ArrayBuffer>, 1);
  hall.buffer = impulse;
  const hallLevel = ctx.createGain();
  hallLevel.gain.value = 0.2;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -2;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.12;

  input.connect(highpass);
  highpass.connect(mud);
  mud.connect(presence);
  presence.connect(air);
  air.connect(compressor);
  compressor.connect(makeup);
  makeup.connect(out);
  makeup.connect(slap);
  slap.connect(slapTone);
  slapTone.connect(slapLevel);
  slapLevel.connect(out);
  makeup.connect(hall);
  hall.connect(hallLevel);
  hallLevel.connect(out);
  out.connect(limiter);
  limiter.connect(ctx.destination);

  const chain: PaChain = {
    input,
    nodes: { input, highpass, mud, presence, air, compressor, makeup, slap, slapTone, slapLevel, hall, hallLevel, out, limiter },
  };
  chains.set(ctx, chain);
  return chain;
}

// --- what is going on, for the development console ------------------------------------------

type AddressTrace = { at: number; event: string; index?: number; detail?: string };

const trace: AddressTrace[] = [];
type AddressState = {
  playing: boolean;
  cue: number;
  cues: number;
  /** Sentences rendered (or given up on) so far. */
  ready: number;
  /** Silence between consecutive sentences as scheduled on the audio clock (ms). */
  gapsMs: number[];
  /** How long AM7 waited, once he could begin, for enough speech to be rendered (ms). */
  waitedMs: number;
};

let lastState: AddressState = { playing: false, cue: -1, cues: 0, ready: 0, gapsMs: [], waitedMs: 0 };

function note(event: string, index?: number, detail?: string): void {
  if (process.env.NODE_ENV === "production") return;
  trace.push({ at: Math.round(typeof performance !== "undefined" ? performance.now() : Date.now()), event, index, detail });
  if (trace.length > 200) trace.splice(0, trace.length - 200);
}

/** Development aid: the context's state, the chain's nodes and the last events. */
export function briefingAddressDebug(): {
  contextState: string | null;
  chain: string[] | null;
  compressorReduction: number | null;
  trace: AddressTrace[];
} & AddressState {
  const ctx = speechAudioContext();
  const chain = ctx ? chains.get(ctx) : undefined;
  const compressor = chain?.nodes.compressor as DynamicsCompressorNode | undefined;
  return {
    contextState: ctx?.state ?? null,
    chain: chain ? Object.keys(chain.nodes) : null,
    compressorReduction: compressor ? compressor.reduction : null,
    ...lastState,
    trace: trace.slice(),
  };
}

// --- when to begin (pure) ------------------------------------------------------------------

/** A sentence as the start planner sees it: its length and, once rendered, its audio's length. */
export type PlannedLine = { chars: number; seconds: number | null; failed?: boolean };

/**
 * Whether AM7 can begin now and say every sentence back to back: at least
 * the first `minReady` sentences are rendered (all of them if fewer), and at
 * the observed rendering pace (`renderMsPerChar`; the speech service renders
 * one sentence at a time, in order) each sentence still to come is ready
 * before the ones before it have been said. Audio not rendered yet is
 * guessed from the rendered sentences' seconds per character.
 */
export function canStartAddress(lines: readonly PlannedLine[], renderMsPerChar: number, gapS = SENTENCE_GAP_S, minReady = 2): boolean {
  const n = lines.length;
  let prefix = 0;
  while (prefix < n && (lines[prefix].seconds !== null || lines[prefix].failed)) prefix++;
  if (prefix === n) return true;
  if (prefix < Math.min(minReady, n)) return false;
  let chars = 0;
  let seconds = 0;
  for (const line of lines) {
    if (line.seconds === null) continue;
    chars += line.chars;
    seconds += line.seconds;
  }
  const perChar = chars > 0 ? seconds / chars : 0.07;
  let play = 0;
  for (let i = 0; i < prefix; i++) play += (lines[i].seconds ?? 0) + gapS;
  let render = 0;
  for (let i = prefix; i < n; i++) {
    const line = lines[i];
    if (line.seconds === null && !line.failed) {
      render += (line.chars * renderMsPerChar) / 1000;
      // Heard `play` seconds from now, rendered `render` seconds from now: it must be there in time.
      if (render > play) return false;
    }
    play += (line.seconds ?? line.chars * perChar) + gapS;
  }
  return true;
}

// --- rendering ahead ------------------------------------------------------------------------

/** Answers that mean the speech service is busy (it renders one line at a time): try again shortly. */
const BUSY = new Set([429, 502, 503, 504]);
const FETCH_ATTEMPTS = 5;
const RETRY_MS = 1500;
/** Before any sentence is rendered: the pace assumed (ms per character; AM7's designed voice on an 8 GB GPU). */
const DEFAULT_RENDER_MS_PER_CHAR = 260;
/** Longest AM7 waits, once he may begin, for enough of his speech to be rendered (ms). */
const START_WAIT_MAX_MS = 90_000;

type Line = {
  text: string;
  state: "pending" | "ready" | "failed";
  buffer: AudioBuffer | null;
  fetchMs: number;
};

async function fetchLine(text: string, options: BriefingAddressOptions, signal: AbortSignal): Promise<ArrayBuffer | null> {
  for (let attempt = 0; attempt < FETCH_ATTEMPTS && !signal.aborted; attempt++) {
    try {
      const response = await fetch("/api/office/voice/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voiceId: options.voiceId ?? null, speed: options.speed ?? 0.96 }),
        signal,
      });
      if (response.ok) return await response.arrayBuffer();
      if (!BUSY.has(response.status)) return null;
      note("busy", undefined, `${response.status}, retry`);
    } catch {
      if (signal.aborted) return null;
    }
    await sleep(RETRY_MS, signal);
  }
  return null;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export type PreparedBriefingAddress = {
  /** Starts the speech (once; later calls return the same handle). */
  play(events?: BriefingAddressEvents): BriefingAddress;
  /** Stops rendering and anything playing. */
  stop(): void;
};

/**
 * Starts rendering `lines` (one sentence each) right away, one request after
 * another, so that by the time AM7 may begin (the floor has gathered) his
 * speech is ready; play() then says it over the PA, back to back. With
 * `audible: false` nothing is fetched: play() walks the cues at reading pace.
 */
export function prepareBriefingAddress(lines: readonly string[], options: BriefingAddressOptions = {}): PreparedBriefingAddress {
  const controller = new AbortController();
  const signal = controller.signal;
  const audible = options.audible !== false;
  const items: Line[] = lines.map((text) => ({ text, state: "pending", buffer: null, fetchMs: 0 }));
  // Wakes whoever waits for the next rendered sentence.
  let wake: (() => void) | null = null;
  let changed = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const settle = () => {
    const resolve = wake;
    changed = new Promise<void>((next) => {
      wake = next;
    });
    resolve?.();
  };
  let renderedChars = 0;
  let renderedMs = 0;
  const renderMsPerChar = () => (renderedChars > 0 ? renderedMs / renderedChars : DEFAULT_RENDER_MS_PER_CHAR);
  lastState = { playing: false, cue: -1, cues: lines.length, ready: 0, gapsMs: [], waitedMs: 0 };
  note("prepare", undefined, `${lines.length} sentences${audible ? "" : " (silent)"}`);

  if (audible) {
    void (async () => {
      const ctx = speechAudioContext();
      for (const [index, item] of items.entries()) {
        if (signal.aborted) return;
        const startedAt = performance.now();
        const data = await fetchLine(item.text, options, signal);
        if (signal.aborted) return;
        item.fetchMs = performance.now() - startedAt;
        if (data && ctx) {
          try {
            // Decoding works while the context is still locked.
            item.buffer = await ctx.decodeAudioData(data);
          } catch {
            item.buffer = null;
          }
        }
        if (signal.aborted) return;
        item.state = item.buffer ? "ready" : "failed";
        if (item.buffer) {
          renderedChars += item.text.length;
          renderedMs += item.fetchMs;
        }
        lastState = { ...lastState, ready: index + 1 };
        note(item.buffer ? "rendered" : "no-audio", index, `${Math.round(item.fetchMs)} ms${item.buffer ? `, ${item.buffer.duration.toFixed(2)} s` : ""}`);
        settle();
      }
    })();
  }

  const whenSettled = async (item: Line) => {
    while (item.state === "pending" && !signal.aborted) await changed;
  };
  const stop = () => {
    if (signal.aborted) return;
    note("stop");
    controller.abort();
    settle();
  };

  let handle: BriefingAddress | null = null;
  return {
    stop,
    play(events: BriefingAddressEvents = {}) {
      if (handle) return handle;
      const started = new Set<number>();
      const ended = new Set<number>();
      const start = (i: number) => {
        if (signal.aborted || started.has(i)) return;
        started.add(i);
        lastState = { ...lastState, playing: true, cue: i };
        note("cue-start", i, lines[i]);
        events.onCueStart?.(i);
      };
      const end = (i: number) => {
        if (signal.aborted || ended.has(i)) return;
        // A start whose timer has not fired yet (a throttled background tab) comes first.
        if (!started.has(i)) start(i);
        ended.add(i);
        note("cue-end", i);
        events.onCueEnd?.(i);
      };
      const hold = async (i: number) => {
        start(i);
        await sleep(Math.max(SILENT_MIN_MS, lines[i].length * SILENT_MS_PER_CHAR), signal);
        end(i);
      };

      const run = async (): Promise<boolean> => {
        if (!audible) {
          for (let i = 0; i < lines.length && !signal.aborted; i++) await hold(i);
          return false;
        }
        const ctx = speechAudioContext();
        if (!ctx) return false;
        if (ctx.state !== "running") {
          note("locked", undefined, ctx.state);
          events.onLocked?.();
        }
        if (!(await whenRunning(ctx, options.gestureTimeoutMs ?? 10 * 60_000))) {
          note("gesture-timeout");
          return false;
        }
        if (signal.aborted) return false;
        note("running");
        events.onUnlocked?.();
        // Enough rendered to say it all back to back (or the wait's cap).
        const waitFrom = performance.now();
        const plan = () =>
          items.map((item): PlannedLine => ({ chars: item.text.length, seconds: item.buffer ? item.buffer.duration : null, failed: item.state === "failed" }));
        while (!signal.aborted && !canStartAddress(plan(), renderMsPerChar()) && performance.now() - waitFrom < START_WAIT_MAX_MS) {
          await Promise.race([changed, sleep(500, signal)]);
        }
        if (signal.aborted) return false;
        const waitedMs = Math.round(performance.now() - waitFrom);
        lastState = { ...lastState, waitedMs };
        note("start", undefined, `${lastState.ready}/${items.length} rendered, waited ${waitedMs} ms`);

        const chain = paChain(ctx);
        const endDuck = beginForegroundSpeech("pa");
        const sources = new Set<AudioBufferSourceNode>();
        const timers = new Set<number>();
        const cut = () => {
          for (const source of sources) {
            try {
              source.stop();
            } catch {
              /* not started */
            }
          }
          for (const timer of timers) window.clearTimeout(timer);
        };
        signal.addEventListener("abort", cut, { once: true });
        let heard = false;
        // The audio clock: where the next sentence starts, and where the last one ends.
        let nextStart = 0;
        let lastEnd = -1;
        const gaps: number[] = [];
        let last: Promise<void> = Promise.resolve();
        try {
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            await whenSettled(item);
            if (signal.aborted) break;
            if (!item.buffer) {
              // No audio for this one: after the one before, held for its reading time.
              await last;
              await hold(i);
              nextStart = ctx.currentTime + SENTENCE_GAP_S;
              lastEnd = -1;
              continue;
            }
            const source = ctx.createBufferSource();
            source.buffer = item.buffer;
            source.connect(chain.input);
            // Back to back on the audio clock: right after the one before, with a breath between.
            const startAt = Math.max(ctx.currentTime + 0.03, nextStart);
            if (lastEnd >= 0) gaps.push(Math.round((startAt - lastEnd) * 1000));
            lastEnd = startAt + item.buffer.duration;
            nextStart = lastEnd + SENTENCE_GAP_S;
            lastState = { ...lastState, gapsMs: gaps.slice() };
            sources.add(source);
            const index = i;
            last = new Promise<void>((resolve) => {
              source.onended = () => {
                sources.delete(source);
                source.disconnect();
                end(index);
                resolve();
              };
            });
            source.start(startAt);
            heard = true;
            // Reported when it is heard: at its place on the audio clock.
            const timer = window.setTimeout(() => {
              timers.delete(timer);
              start(index);
            }, Math.max(0, (startAt - ctx.currentTime) * 1000));
            timers.add(timer);
          }
          await last;
          return heard;
        } finally {
          signal.removeEventListener("abort", cut);
          endDuck();
        }
      };

      const done = run().then(
        (heard) => {
          lastState = { ...lastState, playing: false };
          note("done", undefined, heard ? `heard, gaps ${lastState.gapsMs.join("/")} ms` : "silent");
          return heard;
        },
        (error: unknown) => {
          lastState = { ...lastState, playing: false };
          note("error", undefined, String(error));
          return false;
        },
      );
      handle = { done, stop };
      return handle;
    },
  };
}

/** Renders and says `lines` over the PA at once (prepareBriefingAddress, then play). */
export function playBriefingAddress(
  lines: readonly string[],
  options: BriefingAddressOptions = {},
  events: BriefingAddressEvents = {},
): BriefingAddress {
  return prepareBriefingAddress(lines, options).play(events);
}
