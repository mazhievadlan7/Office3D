// Speech providers for the office: speech-to-text for the microphone and
// text-to-speech for agents' voices.
//
// One interface per direction, one registry, chosen by the server's
// environment (a speech service is infrastructure, not a browser preference):
//   - elevenlabs         ElevenLabs Scribe (STT) and its voices (TTS);
//   - openai-compatible  any server with OpenAI's audio API —
//                        POST {url}/audio/transcriptions and /audio/speech.
//                        That is the way to a free, local voice: e.g. a
//                        faster-whisper server for STT and Kokoro for TTS,
//                        next to the office on the same machine;
//   - openclaw           (STT only) the OpenClaw runtime's own audio pipeline,
//                        for offices still on OpenClaw.
//
// Upstream error bodies are logged, never passed to the browser: they can
// carry account details. The browser gets a short message and a status.

export type SpeechProviderId = "elevenlabs" | "openai-compatible" | "openclaw";

export type TranscriptionRequest = { buffer: Buffer; fileName: string; mimeType: string };
export type TranscriptionResult = {
  transcript: string;
  provider: SpeechProviderId;
  model: string | null;
  ignored: boolean;
};
export type SynthesisRequest = { text: string; voiceId?: string | null; speed?: number };

export interface SttProvider {
  readonly id: SpeechProviderId;
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
}

export interface TtsProvider {
  readonly id: SpeechProviderId;
  /** The default voice and the voices the office offers. */
  voices(): { defaultVoiceId: string; options: Array<{ id: string; label: string }> };
  synthesize(request: SynthesisRequest): Promise<Response>;
}

/** A failure the browser may see: a status and a message without upstream details. */
export class VoiceProviderError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "VoiceProviderError";
  }
}

type Env = Record<string, string | undefined>;
const read = (env: Env, key: string) => env[key]?.trim() || "";

const STT_TIMEOUT_MS = 60_000;
const TTS_TIMEOUT_MS = 30_000;

const ELEVENLABS_API = "https://api.elevenlabs.io/v1";
const ELEVENLABS_DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM"; // Rachel
const ELEVENLABS_VOICES = [
  { id: "21m00Tcm4TlvDq8ikWAM", label: "Rachel" },
  { id: "EXAVITQu4vr4xnSDxMaL", label: "Bella" },
  { id: "MF3mGyEYCl7XYWbV9V6O", label: "Elli" },
  { id: "ErXwobaYiN019PkySvjV", label: "Antoni" },
  { id: "TxGEqnHWrfWFTfGW9XjX", label: "Josh" },
  { id: "pNInz6obpgDQGcFmaJgB", label: "Adam" },
];
const OPENAI_DEFAULT_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];
const VOICE_ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;

const clampSpeed = (value: number | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(1.2, Math.max(0.7, value)) : 1;

/** A voice id from the browser, or the provider's default when it is not a plausible id. */
const pickVoice = (requested: string | null | undefined, fallback: string) => {
  const value = requested?.trim();
  return value && VOICE_ID_RE.test(value) ? value : fallback;
};

const upstreamFailure = async (service: string, response: Response): Promise<never> => {
  const detail = (await response.text().catch(() => "")).slice(0, 500);
  console.error(`[voice] ${service} answered ${response.status}: ${detail}`);
  if (response.status === 401 || response.status === 403) {
    throw new VoiceProviderError(502, `${service}: ключ не принят.`);
  }
  if (response.status === 429) throw new VoiceProviderError(429, `${service}: превышен лимит запросов.`);
  throw new VoiceProviderError(502, `${service} не смог обработать запрос.`);
};

const timedFetch = async (service: string, url: string, init: RequestInit, timeoutMs: number) => {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    console.error(`[voice] ${service} request failed:`, error);
    throw new VoiceProviderError(timedOut ? 504 : 502, timedOut ? `${service} не ответил вовремя.` : `${service} недоступен.`);
  }
};

const audioBlob = (request: TranscriptionRequest) =>
  new Blob([new Uint8Array(request.buffer)], { type: request.mimeType || "application/octet-stream" });

// --- ElevenLabs ------------------------------------------------------------------------

const elevenLabsKey = (env: Env) => {
  const key = read(env, "ELEVENLABS_API_KEY");
  if (!key) throw new VoiceProviderError(503, "Голос не настроен: задайте ELEVENLABS_API_KEY на сервере.");
  return key;
};

const elevenLabsStt = (env: Env): SttProvider => ({
  id: "elevenlabs",
  async transcribe(request) {
    const key = elevenLabsKey(env);
    const models = [read(env, "ELEVENLABS_STT_MODEL_ID") || "scribe_v2", "scribe_v1"];
    for (const [index, model] of models.entries()) {
      const form = new FormData();
      form.set("model_id", model);
      form.set("file", audioBlob(request), request.fileName || "voice-note.webm");
      const language = read(env, "OFFICE3D_STT_LANGUAGE");
      if (language) form.set("language_code", language);
      const response = await timedFetch(
        "ElevenLabs",
        `${ELEVENLABS_API}/speech-to-text`,
        { method: "POST", headers: { "xi-api-key": key }, body: form },
        STT_TIMEOUT_MS,
      );
      // An account or region without the newer model gets the older one.
      if ((response.status === 400 || response.status === 422) && index === 0 && !read(env, "ELEVENLABS_STT_MODEL_ID")) {
        await response.text().catch(() => "");
        continue;
      }
      if (!response.ok) await upstreamFailure("ElevenLabs", response);
      const body = (await response.json().catch(() => ({}))) as { text?: unknown };
      const transcript = typeof body.text === "string" ? body.text.trim() : "";
      return { transcript, provider: "elevenlabs", model, ignored: transcript.length === 0 };
    }
    throw new VoiceProviderError(502, "ElevenLabs не смог распознать речь.");
  },
});

const elevenLabsTts = (env: Env): TtsProvider => {
  const defaultVoiceId = read(env, "ELEVENLABS_VOICE_ID") || ELEVENLABS_DEFAULT_VOICE;
  return {
    id: "elevenlabs",
    voices: () => ({ defaultVoiceId, options: ELEVENLABS_VOICES }),
    async synthesize(request) {
      const key = elevenLabsKey(env);
      const voiceId = pickVoice(request.voiceId, defaultVoiceId);
      const response = await timedFetch(
        "ElevenLabs",
        `${ELEVENLABS_API}/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=mp3_44100_128`,
        {
          method: "POST",
          headers: { Accept: "audio/mpeg", "Content-Type": "application/json", "xi-api-key": key },
          body: JSON.stringify({
            text: request.text,
            model_id: read(env, "ELEVENLABS_MODEL_ID") || "eleven_flash_v2_5",
            voice_settings: {
              stability: 0.42,
              similarity_boost: 0.88,
              style: 0.2,
              use_speaker_boost: true,
              speed: clampSpeed(request.speed),
            },
          }),
        },
        TTS_TIMEOUT_MS,
      );
      if (!response.ok) await upstreamFailure("ElevenLabs", response);
      return response;
    },
  };
};

// --- OpenAI-compatible (local or hosted) ---------------------------------------------

const baseUrl = (env: Env, specific: string) => {
  const url = (read(env, specific) || read(env, "OFFICE3D_VOICE_API_URL")).replace(/\/+$/, "");
  if (!url) {
    throw new VoiceProviderError(503, `Голос не настроен: задайте ${specific} или OFFICE3D_VOICE_API_URL на сервере.`);
  }
  if (!/^https?:\/\//.test(url)) throw new VoiceProviderError(503, `${specific} должен быть адресом http(s).`);
  return url;
};

const bearer = (env: Env): Record<string, string> => {
  const key = read(env, "OFFICE3D_VOICE_API_KEY");
  return key ? { Authorization: `Bearer ${key}` } : {};
};

const openAiStt = (env: Env): SttProvider => ({
  id: "openai-compatible",
  async transcribe(request) {
    const model = read(env, "OFFICE3D_STT_MODEL") || "whisper-1";
    const form = new FormData();
    form.set("model", model);
    form.set("file", audioBlob(request), request.fileName || "voice-note.webm");
    const language = read(env, "OFFICE3D_STT_LANGUAGE");
    if (language) form.set("language", language);
    const response = await timedFetch(
      "Сервер распознавания речи",
      `${baseUrl(env, "OFFICE3D_STT_API_URL")}/audio/transcriptions`,
      { method: "POST", headers: bearer(env), body: form },
      STT_TIMEOUT_MS,
    );
    if (!response.ok) await upstreamFailure("Сервер распознавания речи", response);
    const body = (await response.json().catch(() => ({}))) as { text?: unknown };
    const transcript = typeof body.text === "string" ? body.text.trim() : "";
    return { transcript, provider: "openai-compatible", model, ignored: transcript.length === 0 };
  },
});

const openAiTts = (env: Env): TtsProvider => {
  const listed = read(env, "OFFICE3D_TTS_VOICES")
    .split(",")
    .map((voice) => voice.trim())
    .filter((voice) => VOICE_ID_RE.test(voice));
  const names = listed.length ? listed : OPENAI_DEFAULT_VOICES;
  const defaultVoiceId = pickVoice(read(env, "OFFICE3D_TTS_VOICE"), names[0]);
  return {
    id: "openai-compatible",
    voices: () => ({ defaultVoiceId, options: names.map((id) => ({ id, label: id })) }),
    async synthesize(request) {
      const response = await timedFetch(
        "Сервер озвучки",
        `${baseUrl(env, "OFFICE3D_TTS_API_URL")}/audio/speech`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...bearer(env) },
          body: JSON.stringify({
            model: read(env, "OFFICE3D_TTS_MODEL") || "tts-1",
            input: request.text,
            voice: pickVoice(request.voiceId, defaultVoiceId),
            response_format: "mp3",
            speed: clampSpeed(request.speed),
          }),
        },
        TTS_TIMEOUT_MS,
      );
      if (!response.ok) await upstreamFailure("Сервер озвучки", response);
      return response;
    },
  };
};

// --- OpenClaw (STT) --------------------------------------------------------------------

const openClawStt = (): SttProvider => ({
  id: "openclaw",
  async transcribe(request) {
    const { transcribeVoiceWithOpenClaw } = await import("@/lib/openclaw/voiceTranscription");
    let result;
    try {
      result = await transcribeVoiceWithOpenClaw(request);
    } catch (error) {
      // Local runtime problems (OpenClaw not installed, no audio model): the
      // message says what to fix and holds no secrets.
      throw new VoiceProviderError(503, error instanceof Error ? error.message : "OpenClaw не смог распознать речь.");
    }
    return {
      transcript: result.transcript ?? "",
      provider: "openclaw",
      model: result.model ?? null,
      ignored: Boolean(result.ignored),
    };
  },
});

// --- registry --------------------------------------------------------------------------

const choose = (value: string, allowed: SpeechProviderId[], fallback: SpeechProviderId) =>
  (allowed as string[]).includes(value) ? (value as SpeechProviderId) : fallback;

/** The configured speech-to-text provider. */
export const sttProvider = (env: Env = process.env): SttProvider => {
  const fallback: SpeechProviderId = read(env, "ELEVENLABS_API_KEY") ? "elevenlabs" : "openclaw";
  const id = choose(read(env, "OFFICE3D_STT_PROVIDER"), ["elevenlabs", "openai-compatible", "openclaw"], fallback);
  if (id === "openai-compatible") return openAiStt(env);
  if (id === "openclaw") return openClawStt();
  return elevenLabsStt(env);
};

/** The configured text-to-speech provider. */
export const ttsProvider = (env: Env = process.env): TtsProvider => {
  const id = choose(read(env, "OFFICE3D_TTS_PROVIDER"), ["elevenlabs", "openai-compatible"], "elevenlabs");
  return id === "openai-compatible" ? openAiTts(env) : elevenLabsTts(env);
};

/** What the office may know about the voice setup: providers and voices, no secrets. */
export const describeVoiceSetup = (env: Env = process.env) => {
  const tts = ttsProvider(env);
  const stt = sttProvider(env);
  const ttsReady = tts.id === "elevenlabs" ? Boolean(read(env, "ELEVENLABS_API_KEY")) : Boolean(read(env, "OFFICE3D_TTS_API_URL") || read(env, "OFFICE3D_VOICE_API_URL"));
  const sttReady =
    stt.id === "elevenlabs"
      ? Boolean(read(env, "ELEVENLABS_API_KEY"))
      : stt.id === "openai-compatible"
        ? Boolean(read(env, "OFFICE3D_STT_API_URL") || read(env, "OFFICE3D_VOICE_API_URL"))
        : true;
  return {
    tts: { provider: tts.id, ready: ttsReady, ...tts.voices() },
    stt: { provider: stt.id, ready: sttReady },
  };
};
