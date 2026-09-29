/**
 * The HQ system's own voice — the autonomous platform, not an agent. The
 * speech comes from the same text-to-speech endpoint as the agents' replies
 * (/api/office/voice/reply, asked for the system voice: Silero through the
 * local speech gateway), then goes through a clean, deep treatment
 * (weight, presence, a subtle detuned chorus and a short plate reverb), so it
 * reads as a synthetic system voice and never like AM7 or the crew.
 *
 * Browsers only let a page make sound after a user gesture: when the audio
 * context starts suspended, the speech waits for the first click or key press.
 */

export type SystemVoiceOptions = {
  voiceId?: string | null;
  speed?: number;
  /** Stops waiting for a gesture after this long (ms); the speech is then skipped. */
  gestureTimeoutMs?: number;
};

let context: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (context) return context;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  context = new Ctor();
  return context;
}

/** Resolves once the context runs (at once, or at the next gesture); false if it never does. */
function whenRunning(ctx: AudioContext, timeoutMs: number): Promise<boolean> {
  if (ctx.state === "running") return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      window.removeEventListener("pointerdown", onGesture, true);
      window.removeEventListener("keydown", onGesture, true);
      window.clearTimeout(timer);
      resolve(ok);
    };
    const onGesture = () => {
      void ctx.resume().then(() => finish(ctx.state === "running"));
    };
    window.addEventListener("pointerdown", onGesture, true);
    window.addEventListener("keydown", onGesture, true);
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    // Some browsers allow it right away (the sign-in click on this site counts).
    void ctx.resume().then(() => {
      if (ctx.state === "running") finish(true);
    });
  });
}

/** A short, dense impulse response for the plate reverb (decaying noise). */
function reverbImpulse(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  return impulse;
}

/**
 * A clean, deep, slightly inhuman treatment (no ring modulator, no harsh
 * saturation, so it never sounds hoarse): a full band, a low shelf for weight
 * and chest, a gentle presence lift for authority, a subtle detuned chorus so
 * it reads as synthetic, and a short plate reverb for a mysterious space.
 */
function buildChain(ctx: AudioContext, destination: AudioNode): { input: AudioNode; stop(): void } {
  const input = ctx.createGain();
  const highpass = ctx.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = 85;
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.value = 8800;
  // Weight and chest for a deep, powerful voice.
  const weight = ctx.createBiquadFilter();
  weight.type = "lowshelf";
  weight.frequency.value = 200;
  weight.gain.value = 5.5;
  // A little presence so it stays clear and commanding, not muffled.
  const presence = ctx.createBiquadFilter();
  presence.type = "peaking";
  presence.frequency.value = 2600;
  presence.Q.value = 0.9;
  presence.gain.value = 3;

  // Dry voice, plus a subtle detuned double: the clean "AI" shimmer.
  const dry = ctx.createGain();
  dry.gain.value = 1;
  const chorus = ctx.createGain();
  chorus.gain.value = 0.32;
  const chorusDelay = ctx.createDelay(0.05);
  chorusDelay.delayTime.value = 0.02;
  const lfo = ctx.createOscillator();
  lfo.type = "sine";
  lfo.frequency.value = 0.18;
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = 0.004;
  lfo.connect(lfoDepth);
  lfoDepth.connect(chorusDelay.delayTime);

  // Short plate reverb, low wet: a large, quiet room, not an echo.
  const reverb = ctx.createConvolver();
  reverb.buffer = reverbImpulse(ctx, 1.1, 3.2);
  const wet = ctx.createGain();
  wet.gain.value = 0.16;
  const preWet = ctx.createGain();

  const out = ctx.createDynamicsCompressor();
  out.threshold.value = -16;
  out.ratio.value = 3;
  out.attack.value = 0.006;
  out.release.value = 0.18;
  const level = ctx.createGain();
  level.gain.value = 1;

  input.connect(highpass);
  highpass.connect(lowpass);
  lowpass.connect(weight);
  weight.connect(presence);
  presence.connect(dry);
  presence.connect(chorusDelay);
  chorusDelay.connect(chorus);
  dry.connect(preWet);
  chorus.connect(preWet);
  preWet.connect(out);
  preWet.connect(reverb);
  reverb.connect(wet);
  wet.connect(out);
  out.connect(level);
  level.connect(destination);
  lfo.start();

  return {
    input,
    stop() {
      try {
        lfo.stop();
      } catch {
        // Already stopped.
      }
      for (const node of [input, highpass, lowpass, weight, presence, dry, chorus, chorusDelay, lfo, lfoDepth, reverb, wet, preWet, out, level]) {
        node.disconnect();
      }
    },
  };
}

/**
 * Speaks `text` in the system voice. Resolves when it has finished (or was
 * skipped: no audio, no gesture in time, or the speech service failed).
 */
export function speakSystem(text: string, options: SystemVoiceOptions = {}): Promise<boolean> {
  return prepareSystemSpeech(text, options).play();
}

/**
 * Speaks `text` in an agent's own voice, untreated (AM7 at a briefing when the
 * office's voice replies are off). Same contract as speakSystem.
 */
export function speakAgent(text: string, options: SystemVoiceOptions = {}): Promise<boolean> {
  return prepare(text, options, false).play();
}

/** Speech fetched ahead: the audio starts downloading at once and plays on play(). */
export type PreparedSpeech = {
  /** Plays it (once; later calls return the same promise). Resolves as speakSystem does. */
  play(): Promise<boolean>;
};

/**
 * Fetches the system voice's audio for `text` right away, to play later
 * exactly on cue (e.g. when the HQ's opening fly-through starts) without the
 * speech service's delay.
 */
export function prepareSystemSpeech(text: string, options: SystemVoiceOptions = {}): PreparedSpeech {
  return prepare(text, options, true);
}

function prepare(text: string, options: SystemVoiceOptions, treated: boolean): PreparedSpeech {
  const clean = text.replace(/\s+/g, " ").trim();
  const audio: Promise<ArrayBuffer | null> = clean ? fetchSpeech(clean, options, treated) : Promise.resolve(null);
  let played: Promise<boolean> | null = null;
  return {
    play() {
      if (!played) played = audio.then((data) => (data ? playSpeech(data, options, treated) : false));
      return played;
    },
  };
}

async function fetchSpeech(text: string, options: SystemVoiceOptions, system: boolean): Promise<ArrayBuffer | null> {
  try {
    const response = await fetch("/api/office/voice/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The system speaks with its own voice (the server's system voice,
      // Silero: exact Russian stress), never with an agent's.
      body: JSON.stringify({
        text,
        voiceId: system ? null : (options.voiceId ?? null),
        role: system ? "system" : null,
        speed: options.speed ?? 0.94,
      }),
    });
    if (!response.ok) return null;
    return await response.arrayBuffer();
  } catch {
    return null;
  }
}

async function playSpeech(audio: ArrayBuffer, options: SystemVoiceOptions, treated: boolean): Promise<boolean> {
  const ctx = audioContext();
  if (!ctx) return false;
  // Waits for the first click or key press when the browser has not allowed sound yet.
  if (!(await whenRunning(ctx, options.gestureTimeoutMs ?? 10 * 60_000))) return false;
  let buffer: AudioBuffer;
  try {
    buffer = await ctx.decodeAudioData(audio);
  } catch {
    return false;
  }
  const chain = treated ? buildChain(ctx, ctx.destination) : null;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(chain ? chain.input : ctx.destination);
  return new Promise((resolve) => {
    source.onended = () => {
      source.disconnect();
      // Let the reverb ring out before tearing the chain down.
      if (chain) window.setTimeout(() => chain.stop(), 1200);
      resolve(true);
    };
    source.start();
  });
}
