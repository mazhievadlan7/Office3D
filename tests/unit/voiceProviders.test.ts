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

const mp3 = () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("voice providers", () => {
  it("uses_the_local_speech_gateway_by_default", () => {
    expect(sttProvider({}).id).toBe("local-speech");
    expect(ttsProvider({}).id).toBe("local-speech");
    // The retired provider name means the default now.
    expect(sttProvider({ OFFICE3D_STT_PROVIDER: "elevenlabs" }).id).toBe("local-speech");
    expect(ttsProvider({ OFFICE3D_TTS_PROVIDER: "elevenlabs" }).id).toBe("local-speech");
    expect(sttProvider({ OFFICE3D_STT_PROVIDER: "openclaw" }).id).toBe("openclaw");
    expect(sttProvider({ OFFICE3D_STT_PROVIDER: "openai-compatible" }).id).toBe("openai-compatible");
    expect(ttsProvider({ OFFICE3D_TTS_PROVIDER: "openai-compatible" }).id).toBe("openai-compatible");
  });

  it("transcribes_through_the_gateway_in_russian", async () => {
    const calls = stubFetch(Response.json({ text: " Привет, штаб " }));
    const result = await sttProvider({}).transcribe(audio);
    expect(result).toEqual({ transcript: "Привет, штаб", provider: "local-speech", model: "whisper-1", ignored: false });
    expect(calls[0].url).toBe("http://127.0.0.1:8765/v1/audio/transcriptions");
    const form = calls[0].init.body as FormData;
    expect(form.get("language")).toBe("ru");
    expect(form.get("model")).toBe("whisper-1");
    expect(form.get("file")).toBeInstanceOf(Blob);
  });

  it("accepts_a_gateway_url_with_or_without_v1", async () => {
    const calls = stubFetch(Response.json({ text: "да" }), Response.json({ text: "да" }));
    await sttProvider({ SPEECH_GATEWAY_URL: "http://speech:8765/v1/" }).transcribe(audio);
    await sttProvider({ SPEECH_GATEWAY_URL: "http://speech:8765" }).transcribe(audio);
    expect(calls.map((call) => call.url)).toEqual([
      "http://speech:8765/v1/audio/transcriptions",
      "http://speech:8765/v1/audio/transcriptions",
    ]);
  });

  it("treats_silence_as_ignored", async () => {
    stubFetch(Response.json({ text: "" }));
    const result = await sttProvider({}).transcribe(audio);
    expect(result.ignored).toBe(true);
  });

  it("keeps_upstream_error_details_out_of_the_browser", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(new Response('{"error":{"message":"C:\\\\Users\\\\secret\\\\path traceback"}}', { status: 500 }));
    const failure = await sttProvider({}).transcribe(audio).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(VoiceProviderError);
    expect((failure as VoiceProviderError).status).toBe(502);
    expect((failure as Error).message).not.toContain("secret");
  });

  it("speaks_with_a_gateway_voice", async () => {
    const calls = stubFetch(mp3());
    const response = await ttsProvider({}).synthesize({ text: "Брифинг", voiceId: "voicestudio:crew-f1", speed: 3 });
    expect(response.ok).toBe(true);
    expect(calls[0].url).toBe("http://127.0.0.1:8765/v1/audio/speech");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      input: "Брифинг",
      voice: "voicestudio:crew-f1",
      response_format: "mp3",
      speed: 1.2,
    });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("replaces_a_retired_voice_id_with_the_lead_voice", async () => {
    const calls = stubFetch(mp3(), mp3());
    await ttsProvider({}).synthesize({ text: "x", voiceId: "EXAVITQu4vr4xnSDxMaL" });
    await ttsProvider({ OFFICE3D_TTS_VOICE: "silero:eugene" }).synthesize({ text: "x", voiceId: null });
    expect(JSON.parse(String(calls[0].init.body)).voice).toBe("voicestudio:am7");
    expect(JSON.parse(String(calls[1].init.body)).voice).toBe("silero:eugene");
  });

  it("speaks_as_the_system_with_silero_whatever_voice_was_sent", async () => {
    const calls = stubFetch(mp3(), mp3());
    await ttsProvider({}).synthesize({ text: "Доброе утро", voiceId: "voicestudio:am7", role: "system" });
    await ttsProvider({ OFFICE3D_SYSTEM_VOICE: "silero:eugene" }).synthesize({ text: "Доброе утро", role: "system" });
    expect(JSON.parse(String(calls[0].init.body)).voice).toBe("silero:aidar");
    expect(JSON.parse(String(calls[1].init.body)).voice).toBe("silero:eugene");
  });

  it("says_how_to_start_the_gateway_when_it_is_down", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(new TypeError("fetch failed"));
    const failure = await ttsProvider({}).synthesize({ text: "x" }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 503 });
    expect((failure as Error).message).toContain("npm run speech");
  });

  it("turns_timeouts_into_a_gateway_timeout", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
    const failure = await ttsProvider({}).synthesize({ text: "x" }).catch((e: unknown) => e);
    expect(failure).toMatchObject({ status: 504 });
  });

  it("rejects_a_gateway_url_that_is_not_http", async () => {
    const failure = await ttsProvider({ SPEECH_GATEWAY_URL: "file:///etc/passwd" })
      .synthesize({ text: "x" })
      .catch((e: unknown) => e);
    expect(failure).toMatchObject({ status: 503 });
  });

  it("speaks_through_an_openai_compatible_server_with_a_chosen_voice", async () => {
    const calls = stubFetch(mp3());
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

  it("describes_the_setup_from_the_live_gateway", async () => {
    const calls = stubFetch(
      Response.json({
        object: "list",
        default: "silero:aidar",
        data: [
          { id: "silero:aidar", label: "Система", role: "system", engine: "silero" },
          { id: "voicestudio:am7", label: "AM7", role: "lead", engine: "voicestudio", fallback: "silero:eugene" },
          { id: "voicestudio:crew-m1", label: "М1", role: "crew", engine: "voicestudio" },
          { id: "voicestudio:crew-f1", label: "Ж1", role: "crew", engine: "voicestudio" },
          { id: "not a voice", label: "x" },
        ],
      }),
    );
    const setup = await describeVoiceSetup({ SPEECH_GATEWAY_URL: "http://speech:8765", VOICESTUDIO_API_KEY: "vs-secret" });
    expect(calls[0].url).toBe("http://speech:8765/v1/voices");
    expect(setup.tts).toMatchObject({
      provider: "local-speech",
      ready: true,
      defaultVoiceId: "voicestudio:am7",
      systemVoiceId: "silero:aidar",
      leadVoiceId: "voicestudio:am7",
      crewVoiceIds: ["voicestudio:crew-m1", "voicestudio:crew-f1"],
    });
    expect(setup.tts.options.map((option) => option.id)).toEqual([
      "silero:aidar",
      "voicestudio:am7",
      "voicestudio:crew-m1",
      "voicestudio:crew-f1",
    ]);
    expect(setup.stt).toEqual({ provider: "local-speech", ready: true });
    expect(JSON.stringify(setup)).not.toContain("vs-secret");
  });

  it("describes_the_setup_as_not_ready_when_the_gateway_is_down", async () => {
    stubFetch(new TypeError("fetch failed"));
    const setup = await describeVoiceSetup({});
    expect(setup.tts.ready).toBe(false);
    expect(setup.stt.ready).toBe(false);
    // Settings still show the real voice names.
    expect(setup.tts.options.some((option) => option.id === "voicestudio:am7")).toBe(true);
    expect(setup.tts.crewVoiceIds?.length).toBeGreaterThan(1);
  });
});
