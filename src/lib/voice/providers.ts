// Speech providers for the office: speech-to-text for the microphone and
// text-to-speech for agents' voices.
//
// One interface per direction, one registry, chosen by the server's
// environment (a speech service is infrastructure, not a browser preference):
//   - local-speech       (default) the office's own speech gateway
//                        (services/speech, SPEECH_GATEWAY_URL): Silero TTS v5
//                        for every voice (Russian with exact stress), GigaAM
//                        v3 for speech recognition, all on the CPU. Open
//                        source, on this machine or the office's server;
//   - openai-compatible  any other server with OpenAI's audio API —
//                        POST {url}/audio/transcriptions and /audio/speech;
//   - openclaw           (STT only) the OpenClaw runtime's own audio pipeline,
//                        for offices still on OpenClaw.
//
// Upstream error bodies are logged, never passed to the browser. The browser
// gets a short message and a status.

import {
  BUILTIN_SPEECH_VOICES,
  currentSpeechVoiceId,
  DEFAULT_LEAD_VOICE,
  DEFAULT_SYSTEM_VOICE,
  isSpeechVoiceId,
  parseGatewayVoices,
  voicesWithRole,
  type SpeechVoice,
} from "@/lib/voice/voiceCatalog";

export type SpeechProviderId = "local-speech" | "openai-compatible" | "openclaw";

export type TranscriptionRequest = { buffer: Buffer; fileName: string; mimeType: string };
export type TranscriptionResult = {
  transcript: string;
  provider: SpeechProviderId;
  model: string | null;
  ignored: boolean;
};
export type SynthesisRequest = {
  text: string;
  voiceId?: string | null;
  speed?: number;
  /** "system": the HQ's own voice, whatever voice id was sent. */
  role?: "system" | null;
};

export interface SttProvider {
  readonly id: SpeechProviderId;
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
}

export interface TtsProvider {
  readonly id: SpeechProviderId;
  /** The default voice and the voices the office offers. */
  voices(): { defaultVoiceId: string; options: Array<{ id: string; label: string; role?: string }> };
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
/** A long line on a busy CPU (Silero plus the voice's post-processing) still finishes well within this. */
const GATEWAY_TTS_TIMEOUT_MS = 120_000;
const GATEWAY_STT_TIMEOUT_MS = 120_000;
const GATEWAY_PROBE_TIMEOUT_MS = 2_500;

export const DEFAULT_SPEECH_GATEWAY_URL = "http://127.0.0.1:8765";
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

// --- Local speech gateway (Silero + GigaAM) --------------------------------------

const GATEWAY_SERVICE = "Сервер речи";

/** The gateway's base URL, without a trailing /v1. */
export const speechGatewayUrl = (env: Env) => {
  const url = (read(env, "SPEECH_GATEWAY_URL") || DEFAULT_SPEECH_GATEWAY_URL).replace(/\/+$/, "").replace(/\/v1$/, "");
  if (!/^https?:\/\//.test(url)) throw new VoiceProviderError(503, "SPEECH_GATEWAY_URL должен быть адресом http(s).");
  return url;
};

/** The HQ's own voice («Система штаба»): Silero by default, for exact Russian stress. */
export const systemVoiceId = (env: Env) => {
  const configured = read(env, "OFFICE3D_SYSTEM_VOICE");
  return isSpeechVoiceId(configured) ? currentSpeechVoiceId(configured) : DEFAULT_SYSTEM_VOICE;
};

const gatewayDefaultVoice = (env: Env) => {
  const configured = read(env, "OFFICE3D_TTS_VOICE");
  return isSpeechVoiceId(configured) ? currentSpeechVoiceId(configured) : DEFAULT_LEAD_VOICE;
};

/** A voice id from the browser, or the default when it is not a gateway voice (e.g. an old saved id). */
const pickGatewayVoice = (requested: string | null | undefined, fallback: string) => {
  const value = requested?.trim();
  return value && isSpeechVoiceId(value) ? value : fallback;
};

const gatewayUnavailable = (error: VoiceProviderError) =>
  error.status === 502 && error.message === `${GATEWAY_SERVICE} недоступен.`
    ? new VoiceProviderError(503, "Сервер речи не запущен: npm run speech (см. docs/deployment.md).")
    : error;

const gatewayFetch = async (url: string, init: RequestInit, timeoutMs: number) => {
  try {
    return await timedFetch(GATEWAY_SERVICE, url, init, timeoutMs);
  } catch (error) {
    throw error instanceof VoiceProviderError ? gatewayUnavailable(error) : error;
  }
};

const localSpeechStt = (env: Env): SttProvider => ({
  id: "local-speech",
  async transcribe(request) {
    const model = read(env, "OFFICE3D_STT_MODEL") || "whisper-1";
    const form = new FormData();
    form.set("model", model);
    form.set("file", audioBlob(request), request.fileName || "voice-note.webm");
    form.set("language", read(env, "OFFICE3D_STT_LANGUAGE") || "ru");
    const response = await gatewayFetch(
      `${speechGatewayUrl(env)}/v1/audio/transcriptions`,
      { method: "POST", body: form },
      GATEWAY_STT_TIMEOUT_MS,
    );
    if (!response.ok) await upstreamFailure(GATEWAY_SERVICE, response);
    const body = (await response.json().catch(() => ({}))) as { text?: unknown };
    const transcript = typeof body.text === "string" ? body.text.trim() : "";
    return { transcript, provider: "local-speech", model, ignored: transcript.length === 0 };
  },
});

const localSpeechTts = (env: Env): TtsProvider => {
  const defaultVoiceId = gatewayDefaultVoice(env);
  return {
    id: "local-speech",
    voices: () => ({
      defaultVoiceId,
      options: BUILTIN_SPEECH_VOICES.map(({ id, label, role }) => ({ id, label, role })),
    }),
    async synthesize(request) {
      const voice = request.role === "system" ? systemVoiceId(env) : pickGatewayVoice(request.voiceId, defaultVoiceId);
      const response = await gatewayFetch(
        `${speechGatewayUrl(env)}/v1/audio/speech`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "audio/mpeg" },
          body: JSON.stringify({ input: request.text, voice, response_format: "mp3", speed: clampSpeed(request.speed) }),
        },
        GATEWAY_TTS_TIMEOUT_MS,
      );
      if (!response.ok) await upstreamFailure(GATEWAY_SERVICE, response);
      return response;
    },
  };
};

/** The gateway's live voice list, or null when it does not answer. */
const fetchGatewayVoices = async (env: Env): Promise<SpeechVoice[] | null> => {
  try {
    const response = await fetch(`${speechGatewayUrl(env)}/v1/voices`, {
      cache: "no-store",
      signal: AbortSignal.timeout(GATEWAY_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const voices = parseGatewayVoices(await response.json().catch(() => null));
    return voices.length ? voices : null;
  } catch {
    return null;
  }
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
  const id = choose(read(env, "OFFICE3D_STT_PROVIDER"), ["local-speech", "openai-compatible", "openclaw"], "local-speech");
  if (id === "openai-compatible") return openAiStt(env);
  if (id === "openclaw") return openClawStt();
  return localSpeechStt(env);
};

/** The configured text-to-speech provider. */
export const ttsProvider = (env: Env = process.env): TtsProvider => {
  const id = choose(read(env, "OFFICE3D_TTS_PROVIDER"), ["local-speech", "openai-compatible"], "local-speech");
  return id === "openai-compatible" ? openAiTts(env) : localSpeechTts(env);
};

/**
 * What the office may know about the voice setup: providers, readiness and
 * voices (with who speaks with which), no secrets. With the local gateway the
 * voices and readiness come from the gateway itself.
 */
export const describeVoiceSetup = async (env: Env = process.env) => {
  const tts = ttsProvider(env);
  const stt = sttProvider(env);
  const usesGateway = tts.id === "local-speech" || stt.id === "local-speech";
  const live = usesGateway ? await fetchGatewayVoices(env) : null;
  const gatewayUp = live !== null;
  const hasOpenAiUrl = (specific: string) => Boolean(read(env, specific) || read(env, "OFFICE3D_VOICE_API_URL"));

  let voices = tts.voices();
  let roles: { systemVoiceId: string | null; leadVoiceId: string | null; crewVoiceIds: string[] } = {
    systemVoiceId: null,
    leadVoiceId: null,
    crewVoiceIds: [],
  };
  if (tts.id === "local-speech") {
    const catalog = live ?? BUILTIN_SPEECH_VOICES;
    const lead = read(env, "OFFICE3D_TTS_VOICE");
    voices = {
      defaultVoiceId: voices.defaultVoiceId,
      options: catalog.map(({ id, label, role }) => ({ id, label, role })),
    };
    roles = {
      systemVoiceId: systemVoiceId(env),
      leadVoiceId: isSpeechVoiceId(lead)
        ? currentSpeechVoiceId(lead)
        : (voicesWithRole(catalog, "lead")[0] ?? DEFAULT_LEAD_VOICE),
      crewVoiceIds: voicesWithRole(catalog, "crew"),
    };
  }
  return {
    tts: {
      provider: tts.id,
      ready: tts.id === "local-speech" ? gatewayUp : hasOpenAiUrl("OFFICE3D_TTS_API_URL"),
      ...voices,
      ...roles,
    },
    stt: {
      provider: stt.id,
      ready:
        stt.id === "local-speech" ? gatewayUp : stt.id === "openai-compatible" ? hasOpenAiUrl("OFFICE3D_STT_API_URL") : true,
    },
  };
};
