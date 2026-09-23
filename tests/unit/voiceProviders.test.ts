// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeVoiceSetup, sttProvider, ttsProvider, VoiceProviderError } from "@/lib/voice/providers";

const audio = { buffer: Buffer.from("fake-audio"), fileName: "voice.webm", mimeType: "audio/webm" };

const stubFetch = (...responses: Array<Response | Error>) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("voice providers", () => {
  it("picks_providers_from_the_server_environment", () => {
    expect(sttProvider({}).id).toBe("openclaw");
    expect(sttProvider({ ELEVENLABS_API_KEY: "k" }).id).toBe("elevenlabs");
    expect(sttProvider({ OFFICE3D_STT_PROVIDER: "openai-compatible" }).id).toBe("openai-compatible");
    expect(ttsProvider({}).id).toBe("elevenlabs");
    expect(ttsProvider({ OFFICE3D_TTS_PROVIDER: "openai-compatible" }).id).toBe("openai-compatible");
    expect(ttsProvider({ OFFICE3D_TTS_PROVIDER: "nonsense" }).id).toBe("elevenlabs");
  });

  it("transcribes_with_elevenlabs_scribe_and_falls_back_to_v1", async () => {
    const calls = stubFetch(
      new Response("unknown model", { status: 422 }),
      Response.json({ text: " Привет, команда " }),
    );
    const result = await sttProvider({ ELEVENLABS_API_KEY: "secret", OFFICE3D_STT_LANGUAGE: "ru" }).transcribe(audio);
    expect(result).toEqual({ transcript: "Привет, команда", provider: "elevenlabs", model: "scribe_v1", ignored: false });
    expect(calls[0].url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect((calls[0].init.headers as Record<string, string>)["xi-api-key"]).toBe("secret");
    const form = calls[1].init.body as FormData;
    expect(form.get("model_id")).toBe("scribe_v1");
    expect(form.get("language_code")).toBe("ru");
    expect(form.get("file")).toBeInstanceOf(Blob);
  });

  it("treats_silence_as_ignored", async () => {
    stubFetch(Response.json({ text: "" }));
    const result = await sttProvider({ ELEVENLABS_API_KEY: "k" }).transcribe(audio);
    expect(result.ignored).toBe(true);
  });

  it("keeps_upstream_error_details_out_of_the_browser", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(new Response("invalid api key sk_live_123 for account foo@example.com", { status: 401 }));
    const failure = await sttProvider({ ELEVENLABS_API_KEY: "k", ELEVENLABS_STT_MODEL_ID: "scribe_v2" })
      .transcribe(audio)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(VoiceProviderError);
    expect((failure as VoiceProviderError).status).toBe(502);
    expect((failure as Error).message).not.toContain("sk_live");
  });

  it("reports_a_missing_key_as_not_configured", async () => {
    const failure = await ttsProvider({}).synthesize({ text: "Привет" }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 503 });
  });

  it("speaks_through_an_openai_compatible_server_with_a_chosen_voice", async () => {
    const calls = stubFetch(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } }));
    const tts = ttsProvider({
      OFFICE3D_TTS_PROVIDER: "openai-compatible",
      OFFICE3D_TTS_API_URL: "http://kokoro:8880/v1/",
      OFFICE3D_TTS_MODEL: "kokoro",
      OFFICE3D_TTS_VOICES: "af_bella, am_adam, bad voice!",
      OFFICE3D_VOICE_API_KEY: "local-key",
    });
    expect(tts.voices()).toEqual({
      defaultVoiceId: "af_bella",
      options: [
        { id: "af_bella", label: "af_bella" },
        { id: "am_adam", label: "am_adam" },
      ],
    });
    const response = await tts.synthesize({ text: "Привет", voiceId: "am_adam", speed: 3 });
    expect(response.ok).toBe(true);
    expect(calls[0].url).toBe("http://kokoro:8880/v1/audio/speech");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      model: "kokoro",
      input: "Привет",
      voice: "am_adam",
      response_format: "mp3",
      speed: 1.2,
    });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer local-key");
  });

  it("transcribes_through_an_openai_compatible_server", async () => {
    const calls = stubFetch(Response.json({ text: "Всем привет" }));
    const result = await sttProvider({
      OFFICE3D_STT_PROVIDER: "openai-compatible",
      OFFICE3D_VOICE_API_URL: "http://whisper:8000/v1",
      OFFICE3D_STT_MODEL: "Systran/faster-whisper-small",
    }).transcribe(audio);
    expect(result).toMatchObject({ transcript: "Всем привет", provider: "openai-compatible" });
    expect(calls[0].url).toBe("http://whisper:8000/v1/audio/transcriptions");
    expect((calls[0].init.body as FormData).get("model")).toBe("Systran/faster-whisper-small");
  });

  it("turns_timeouts_into_a_gateway_timeout", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
    const failure = await ttsProvider({ ELEVENLABS_API_KEY: "k" }).synthesize({ text: "x" }).catch((e: unknown) => e);
    expect(failure).toMatchObject({ status: 504 });
  });

  it("describes_the_setup_without_secrets", () => {
    const setup = describeVoiceSetup({ ELEVENLABS_API_KEY: "secret-key", ELEVENLABS_VOICE_ID: "EXAVITQu4vr4xnSDxMaL" });
    expect(setup.tts).toMatchObject({ provider: "elevenlabs", ready: true, defaultVoiceId: "EXAVITQu4vr4xnSDxMaL" });
    expect(setup.stt).toMatchObject({ provider: "elevenlabs", ready: true });
    expect(JSON.stringify(setup)).not.toContain("secret-key");
  });
});
