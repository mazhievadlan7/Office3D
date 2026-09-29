"""Routing and validation of the gateway, with both engines mocked."""

from __future__ import annotations

import io
import json
from pathlib import Path

import httpx
import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from speech_gateway.app import create_app
from speech_gateway.cache import SpeechCache
from speech_gateway.config import SERVICE_DIR, Settings, is_loopback
from speech_gateway.voices import VoiceCatalog
from speech_gateway.voicestudio import VoiceStudioClient

from conftest import FakeSilero


def wav_bytes(seconds: float = 0.2, rate: int = 24_000) -> bytes:
    buffer = io.BytesIO()
    t = np.arange(int(seconds * rate)) / rate
    sf.write(buffer, (0.1 * np.sin(2 * np.pi * 330 * t)).astype(np.float32), rate, format="WAV", subtype="PCM_16")
    return buffer.getvalue()


class FakeVoiceStudio:
    """A mock VoiceStudio backend behind httpx.MockTransport; records requests."""

    def __init__(self, *, down: bool = False, speech_status: int = 200) -> None:
        self.down = down
        self.speech_status = speech_status
        self.requests: list[httpx.Request] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.down:
            raise httpx.ConnectError("refused", request=request)
        if request.url.path == "/health":
            return httpx.Response(200, json={"status": "ok"})
        if request.url.path == "/v1/audio/speech":
            if self.speech_status != 200:
                return httpx.Response(self.speech_status, json={"error": {"message": "engine not installed"}})
            return httpx.Response(200, content=wav_bytes(), headers={"content-type": "audio/wav"})
        if request.url.path == "/v1/audio/transcriptions":
            return httpx.Response(200, json={"text": "привет штаб"})
        return httpx.Response(404, json={"detail": "not found"})

    def client(self) -> VoiceStudioClient:
        return VoiceStudioClient("http://vs.test", transport=httpx.MockTransport(self.handler))


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(home=tmp_path, warmup=False, max_input_chars=200, max_upload_mb=1)


def make_client(settings: Settings, silero=None, vs: FakeVoiceStudio | None = None, cache: bool = True) -> TestClient:
    vs = vs or FakeVoiceStudio()
    app = create_app(
        settings,
        silero=silero or FakeSilero(),
        voicestudio=vs.client(),
        cache=SpeechCache(settings.cache_dir, 10 * 1024 * 1024, enabled=cache),
        warmup=False,
    )
    return TestClient(app)


def test_voices_lists_both_engines_and_roles(settings):
    body = make_client(settings).get("/v1/voices").json()
    ids = {voice["id"]: voice for voice in body["data"]}
    assert body["default"] == "silero:aidar"
    assert ids["silero:aidar"]["role"] == "system"
    assert ids["voicestudio:am7"]["role"] == "lead"
    assert ids["voicestudio:am7"]["fallback"] == "silero:eugene"
    assert {"silero:baya", "silero:kseniya", "silero:xenia", "silero:eugene"} <= set(ids)
    assert sum(1 for v in body["data"] if v["role"] == "crew") >= 2
    # Nothing engine-internal (seeds, prompts) leaks into the list.
    assert "params" not in ids["voicestudio:am7"]


def test_silero_voice_is_served_locally(settings):
    silero = FakeSilero()
    vs = FakeVoiceStudio()
    client = make_client(settings, silero, vs)
    response = client.post("/v1/audio/speech", json={"voice": "silero:baya", "input": "Привет,   штаб!", "response_format": "wav"})
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"
    assert response.headers["x-speech-engine"] == "silero"
    assert silero.calls == [("Привет, штаб!", "baya", 1.0)]
    assert not any(r.url.path == "/v1/audio/speech" for r in vs.requests)
    data, rate = sf.read(io.BytesIO(response.content))
    assert rate == 48_000 and len(data) > 0


def test_default_and_openai_voice_names_use_the_default_voice(settings):
    silero = FakeSilero()
    client = make_client(settings, silero)
    for voice in (None, "default", "alloy"):
        payload = {"input": f"Проверка {voice}"}
        if voice:
            payload["voice"] = voice
        response = client.post("/v1/audio/speech", json=payload)
        assert response.status_code == 200
        assert response.headers["x-speech-voice"] == "silero:aidar"
        assert response.headers["content-type"] == "audio/mpeg"


def test_voicestudio_preset_is_forwarded_with_its_design(settings):
    vs = FakeVoiceStudio()
    client = make_client(settings, vs=vs)
    response = client.post("/v1/audio/speech", json={"voice": "voicestudio:am7", "input": "Брифинг начинается.", "speed": 0.9})
    assert response.status_code == 200
    assert response.headers["x-speech-engine"] == "voicestudio"
    sent = json.loads([r for r in vs.requests if r.url.path == "/v1/audio/speech"][0].content)
    assert sent["model"] == "voxcpm2"
    assert sent["response_format"] == "wav"
    assert sent["seed"] == 7 and sent["language"] == "ru" and sent["description"]
    assert sent["speed"] == 0.9 and sent["input"] == "Брифинг начинается."


def test_long_text_goes_to_voicestudio_sentence_by_sentence(tmp_path):
    vs = FakeVoiceStudio()
    client = make_client(Settings(home=tmp_path, warmup=False), vs=vs)
    text = " ".join(f"Предложение номер {i} о ходе операции и её целях." for i in range(40))
    response = client.post("/v1/audio/speech", json={"voice": "voicestudio:am7", "input": text, "response_format": "wav"})
    assert response.status_code == 200
    sent = [json.loads(r.content)["input"] for r in vs.requests if r.url.path == "/v1/audio/speech"]
    assert len(sent) > 1 and all(len(chunk) <= 500 for chunk in sent)
    assert " ".join(sent) == text
    data, rate = sf.read(io.BytesIO(response.content))
    assert rate == 24_000 and len(data) > len(sent) * 0.2 * rate


def test_ad_hoc_voicestudio_voice_and_model_override(settings):
    vs = FakeVoiceStudio()
    client = make_client(settings, vs=vs)
    response = client.post(
        "/v1/audio/speech", json={"voice": "voicestudio:profile-123", "model": "omnivoice", "input": "Тест"}
    )
    assert response.status_code == 200
    sent = json.loads([r for r in vs.requests if r.url.path == "/v1/audio/speech"][0].content)
    assert sent["voice"] == "profile-123" and sent["model"] == "omnivoice"
    # OpenAI model ids do not override the engine.
    client.post("/v1/audio/speech", json={"voice": "voicestudio:am7", "model": "tts-1", "input": "Другой текст"})
    sent = json.loads([r for r in vs.requests if r.url.path == "/v1/audio/speech"][-1].content)
    assert sent["model"] == "voxcpm2"


def test_voicestudio_down_falls_back_to_silero(settings):
    silero = FakeSilero()
    client = make_client(settings, silero, FakeVoiceStudio(down=True))
    response = client.post("/v1/audio/speech", json={"voice": "voicestudio:am7", "input": "Резерв"})
    assert response.status_code == 200
    assert response.headers["x-speech-fallback"] == "silero:eugene"
    assert silero.calls[-1][1] == "eugene"


def test_after_a_failure_fallback_voices_skip_voicestudio_for_a_while(settings):
    vs = FakeVoiceStudio(down=True)
    silero = FakeSilero()
    client = make_client(settings, silero, vs, cache=False)
    client.post("/v1/audio/speech", json={"voice": "voicestudio:am7", "input": "Раз"})
    tried = len([r for r in vs.requests if r.url.path == "/v1/audio/speech"])
    vs.down = False
    response = client.post("/v1/audio/speech", json={"voice": "voicestudio:crew-f1", "input": "Два"})
    assert response.headers["x-speech-fallback"] == "silero:baya"
    assert len([r for r in vs.requests if r.url.path == "/v1/audio/speech"]) == tried
    # A voice without a fallback still tries VoiceStudio.
    assert client.post("/v1/audio/speech", json={"voice": "voicestudio:x", "input": "Три"}).status_code == 200


def test_voicestudio_down_without_fallback_is_503(settings):
    client = make_client(settings, vs=FakeVoiceStudio(down=True))
    response = client.post("/v1/audio/speech", json={"voice": "voicestudio:someone", "input": "Тест"})
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "voicestudio_error"


def test_voicestudio_refusal_is_not_masked_by_fallback(settings):
    client = make_client(settings, vs=FakeVoiceStudio(speech_status=400))
    response = client.post("/v1/audio/speech", json={"voice": "voicestudio:am7", "input": "Тест"})
    assert response.status_code == 400
    assert "engine not installed" in response.json()["error"]["message"]


@pytest.mark.parametrize(
    "payload, param",
    [
        ({"voice": "silero:aidar"}, "input"),
        ({"voice": "silero:aidar", "input": ""}, "input"),
        ({"voice": "silero:aidar", "input": "   "}, "input"),
        ({"voice": "silero:aidar", "input": "x" * 201}, "input"),
        ({"voice": "silero:nobody", "input": "Тест"}, "voice"),
        ({"voice": "elevenlabs:rachel", "input": "Тест"}, "voice"),
        ({"voice": "21m00Tcm4TlvDq8ikWAM", "input": "Тест"}, "voice"),
        ({"voice": "silero:aidar", "input": "Тест", "response_format": "aac"}, "response_format"),
        ({"voice": "silero:aidar", "input": "Тест", "speed": 9}, "speed"),
    ],
)
def test_speech_validation(settings, payload, param):
    response = make_client(settings).post("/v1/audio/speech", json=payload)
    assert response.status_code == 400
    error = response.json()["error"]
    assert error["type"] == "invalid_request_error"
    assert error["param"] == param


def test_engine_failure_is_a_503_without_details(settings):
    client = make_client(settings, FakeSilero(fail=True))
    response = client.post("/v1/audio/speech", json={"voice": "silero:aidar", "input": "Тест"})
    assert response.status_code == 503
    assert "exploded" not in response.text


def test_speech_is_cached_by_request(settings):
    silero = FakeSilero()
    client = make_client(settings, silero)
    payload = {"voice": "silero:xenia", "input": "Кэш", "response_format": "opus"}
    first = client.post("/v1/audio/speech", json=payload)
    second = client.post("/v1/audio/speech", json=payload)
    assert first.headers["x-speech-cache"] == "miss" and second.headers["x-speech-cache"] == "hit"
    assert first.content == second.content and len(silero.calls) == 1
    client.post("/v1/audio/speech", json={**payload, "speed": 1.2})
    assert len(silero.calls) == 2


@pytest.mark.parametrize("fmt, media", [("mp3", "audio/mpeg"), ("flac", "audio/flac"), ("opus", "audio/ogg"), ("pcm", "audio/pcm")])
def test_formats(settings, fmt, media):
    response = make_client(settings, cache=False).post("/v1/audio/speech", json={"input": "Формат", "response_format": fmt})
    assert response.status_code == 200 and response.headers["content-type"] == media
    if fmt == "pcm":  # 0.1 s at 24 kHz, 16-bit
        assert abs(len(response.content) - 4800) <= 4


def test_transcription_is_forwarded_with_language_default(settings):
    vs = FakeVoiceStudio()
    client = make_client(settings, vs=vs)
    response = client.post(
        "/v1/audio/transcriptions",
        files={"file": ("note.webm", b"\x1a\x45\xdf\xa3fake", "audio/webm")},
        data={"model": "whisper-1"},
    )
    assert response.status_code == 200
    assert response.json() == {"text": "привет штаб"}
    forwarded = [r for r in vs.requests if r.url.path == "/v1/audio/transcriptions"][0]
    body = forwarded.content.decode("latin-1")
    assert 'name="language"' in body and "ru" in body
    assert 'filename="note.webm"' in body


def test_transcription_validation(settings):
    client = make_client(settings)
    assert client.post("/v1/audio/transcriptions", data={"model": "x"}).status_code == 400
    empty = client.post("/v1/audio/transcriptions", files={"file": ("a.wav", b"", "audio/wav")})
    assert empty.status_code == 400
    big = client.post("/v1/audio/transcriptions", files={"file": ("a.wav", b"0" * (1024 * 1024 + 1), "audio/wav")})
    assert big.status_code == 413
    bad = client.post(
        "/v1/audio/transcriptions", files={"file": ("a.wav", wav_bytes(), "audio/wav")}, data={"response_format": "xml"}
    )
    assert bad.status_code == 400


def test_transcription_when_voicestudio_is_down(settings):
    client = make_client(settings, vs=FakeVoiceStudio(down=True))
    response = client.post("/v1/audio/transcriptions", files={"file": ("a.wav", wav_bytes(), "audio/wav")})
    assert response.status_code == 503
    assert response.json()["error"]["message"] == "VoiceStudio is not reachable."


def test_health_reports_engines(settings):
    body = make_client(settings, vs=FakeVoiceStudio(down=True)).get("/health").json()
    assert body["status"] == "ok"
    assert body["engines"]["silero"]["ready"] is True
    assert body["engines"]["voicestudio"]["reachable"] is False


def test_api_key_goes_only_to_voicestudio(settings):
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, content=wav_bytes())

    client = VoiceStudioClient("http://vs.test", api_key="k-123", transport=httpx.MockTransport(handler))
    app = create_app(settings, silero=FakeSilero(), voicestudio=client, warmup=False)
    TestClient(app).post("/v1/audio/speech", json={"voice": "voicestudio:am7", "input": "Ключ"})
    assert seen[0].headers["authorization"] == "Bearer k-123"
    assert "k-123" not in repr(Settings(voicestudio_api_key="k-123"))


def test_bind_is_loopback_only(monkeypatch):
    assert is_loopback("127.0.0.1") and is_loopback("::1") and is_loopback("localhost")
    assert not is_loopback("0.0.0.0")
    Settings(host="127.0.0.1").check_bind()
    monkeypatch.delenv("SPEECH_ALLOW_NON_LOOPBACK", raising=False)
    with pytest.raises(SystemExit):
        Settings(host="0.0.0.0").check_bind()
    monkeypatch.setenv("SPEECH_ALLOW_NON_LOOPBACK", "1")
    Settings(host="0.0.0.0").check_bind()


def test_shipped_voices_file_parses():
    catalog = VoiceCatalog.load(SERVICE_DIR / "voices.json", "silero:aidar", "voxcpm2")
    for voice in catalog.list():
        if voice.fallback:
            assert catalog.resolve(voice.fallback).engine == "silero"
