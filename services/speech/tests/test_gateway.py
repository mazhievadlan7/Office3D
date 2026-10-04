"""Routing and validation of the gateway, with the engines mocked."""

from __future__ import annotations

import io
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from speech_gateway.app import create_app
from speech_gateway.cache import SpeechCache
from speech_gateway.config import SERVICE_DIR, Settings, is_loopback
from speech_gateway.text import StressLexicon
from speech_gateway.voices import VoiceCatalog

from conftest import FakeSilero, FakeStt


def wav_bytes(seconds: float = 0.2, rate: int = 24_000) -> bytes:
    buffer = io.BytesIO()
    t = np.arange(int(seconds * rate)) / rate
    sf.write(buffer, (0.1 * np.sin(2 * np.pi * 330 * t)).astype(np.float32), rate, format="WAV", subtype="PCM_16")
    return buffer.getvalue()


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(home=tmp_path, warmup=False, max_input_chars=200, max_upload_mb=1)


def make_client(
    settings: Settings,
    silero=None,
    cache: bool = True,
    stt=None,
    stress: StressLexicon | None = None,
) -> TestClient:
    app = create_app(
        settings,
        silero=silero or FakeSilero(),
        cache=SpeechCache(settings.cache_dir, 10 * 1024 * 1024, enabled=cache),
        stt=stt or FakeStt(),
        warmup=False,
        stress=stress,
    )
    return TestClient(app)


def test_voices_lists_the_casting_and_roles(settings):
    body = make_client(settings).get("/v1/voices").json()
    ids = {voice["id"]: voice for voice in body["data"]}
    assert body["default"] == "silero:aidar"
    assert ids["silero:system"]["role"] == "system" and ids["silero:system"]["fx"] == "humanoid-heavy"
    assert ids["silero:am7"]["role"] == "lead" and ids["silero:am7"]["fx"] == "humanoid-heavy-lead"
    assert {"silero:aidar", "silero:eugene"} <= set(ids)
    assert all(voice["engine"] == "silero" for voice in body["data"])
    # Male voices only.
    assert not {"silero:baya", "silero:kseniya", "silero:xenia"} & set(ids)
    assert all(voice.get("gender", "male") == "male" for voice in body["data"])
    assert sum(1 for v in body["data"] if v["role"] == "crew") == 6
    # Nothing engine-internal leaks into the list.
    assert "params" not in ids["silero:am7"]


def test_silero_voice_is_served(settings):
    silero = FakeSilero()
    client = make_client(settings, silero)
    response = client.post("/v1/audio/speech", json={"voice": "silero:eugene", "input": "Привет,   штаб!", "response_format": "wav"})
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"
    assert response.headers["x-speech-engine"] == "silero"
    assert silero.calls == [("Привет, штаб!", "eugene", 1.0)]
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


def test_am7_speaks_with_his_own_silero_voice_and_treatment(settings):
    silero = FakeSilero()
    client = make_client(settings, silero)
    response = client.post("/v1/audio/speech", json={"voice": "silero:am7", "input": "Брифинг начинается.", "speed": 0.9})
    assert response.status_code == 200
    assert response.headers["x-speech-voice"] == "silero:am7"
    assert response.headers["x-speech-fx"] == "humanoid-heavy-lead"
    assert silero.calls == [("Брифинг начинается.", "ru_safarhuja", 0.9)]


@pytest.mark.parametrize(
    "legacy, preset, speaker",
    [
        ("voicestudio:am7", "silero:am7", "ru_safarhuja"),
        ("voicestudio:crew-m1", "silero:crew-m1", "ru_bogdan"),
        ("voicestudio:crew-m6", "silero:crew-m6", "ru_dmitriy"),
        ("voicestudio:crew-f1", "silero:crew-m1", "ru_bogdan"),
        ("voicestudio:crew-f2", "silero:crew-m2", "ru_alexandr"),
    ],
)
def test_retired_voicestudio_ids_speak_with_their_silero_presets(settings, legacy, preset, speaker):
    silero = FakeSilero()
    response = make_client(settings, silero, cache=False).post("/v1/audio/speech", json={"voice": legacy, "input": "Старая настройка"})
    assert response.status_code == 200
    assert response.headers["x-speech-voice"] == preset
    assert silero.calls[-1][1] == speaker


def test_crew_voices_use_the_hard_humanoid_treatment(settings):
    response = make_client(settings).post("/v1/audio/speech", json={"voice": "silero:crew-m3", "input": "Принято."})
    assert response.headers["x-speech-fx"] == "humanoid-hard"


def test_an_unknown_voicestudio_voice_is_the_default_voice(settings):
    response = make_client(settings).post("/v1/audio/speech", json={"voice": "voicestudio:profile-123", "input": "Тест"})
    assert response.status_code == 200 and response.headers["x-speech-voice"] == "silero:aidar"


@pytest.mark.parametrize(
    "legacy, speaker",
    [("silero:baya", "aidar"), ("silero:kseniya", "aidar"), ("silero:xenia", "aidar"), ("silero:ru_zinaida", "aidar")],
)
def test_retired_female_silero_voices_speak_with_a_male_voice(settings, legacy, speaker):
    silero = FakeSilero()
    client = make_client(settings, silero, cache=False)
    response = client.post("/v1/audio/speech", json={"voice": legacy, "input": "Старая настройка", "response_format": "wav"})
    assert response.status_code == 200
    assert silero.calls[-1][1] == speaker


def test_retired_voices_without_their_presets_are_the_default_voice():
    catalog = VoiceCatalog.load(SERVICE_DIR / "voices.json", "silero:aidar")
    assert catalog.resolve("silero:baya").id == "silero:aidar"
    assert all(voice.params.get("speaker") not in {"baya", "kseniya", "xenia"} for voice in catalog.list())
    bare = VoiceCatalog([], "silero:eugene")
    assert bare.resolve("voicestudio:crew-f1").id == "silero:eugene"
    assert bare.resolve("voicestudio:am7").id == "silero:eugene"


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
    payload = {"voice": "silero:eugene", "input": "Кэш", "response_format": "opus"}
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


def test_transcription_is_local(settings):
    stt = FakeStt()
    client = make_client(settings, stt=stt)
    for _ in range(3):
        response = client.post(
            "/v1/audio/transcriptions",
            files={"file": ("voice-note.webm", b"\x1a\x45\xdf\xa3fake", "audio/webm")},
            data={"model": "whisper-1", "language": "ru"},
        )
        assert response.status_code == 200
        assert response.json() == {"text": "Покажи статус операции."}
        assert response.headers["x-speech-stt-engine"] == "gigaam"
    assert len(stt.calls) == 3 and stt.calls[0].startswith(b"\x1a\x45\xdf\xa3")


@pytest.mark.parametrize(
    "fmt, check",
    [
        ("text", lambda r: r.text == "Покажи статус операции."),
        ("verbose_json", lambda r: r.json()["segments"][0]["start"] == 0.4 and r.json()["duration"] == 3.2),
        ("srt", lambda r: r.text.startswith("1\n00:00:00,400 --> 00:00:02,900\nПокажи")),
        ("vtt", lambda r: r.text.startswith("WEBVTT\n\n00:00:00.400 --> 00:00:02.900\n")),
    ],
)
def test_local_transcription_formats(settings, fmt, check):
    response = make_client(settings).post(
        "/v1/audio/transcriptions", files={"file": ("a.wav", wav_bytes(), "audio/wav")}, data={"response_format": fmt}
    )
    assert response.status_code == 200 and check(response)


def test_recognition_failure_is_a_clear_503(settings):
    client = make_client(settings, stt=FakeStt(fail=RuntimeError("boom")))
    response = client.post("/v1/audio/transcriptions", files={"file": ("a.wav", wav_bytes(), "audio/wav")})
    assert response.status_code == 503 and "boom" not in response.text
    assert response.json()["error"]["message"] == "Speech recognition (GigaAM) could not run right now."


def test_undecodable_upload_is_400(settings):
    from speech_gateway.audio import UndecodableAudio

    client = make_client(settings, stt=FakeStt(fail=UndecodableAudio("could not decode the audio")))
    response = client.post("/v1/audio/transcriptions", files={"file": ("a.bin", b"junk", "application/octet-stream")})
    assert response.status_code == 400 and response.json()["error"]["param"] == "file"


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


def test_health_reports_engines(settings):
    body = make_client(settings).get("/health").json()
    assert body["status"] == "ok"
    assert set(body["engines"]) == {"silero", "stt"}
    assert body["engines"]["silero"]["ready"] is True
    assert body["engines"]["stt"]["engine"] == "gigaam"


def test_startup_warms_every_engine_once(tmp_path):
    silero, stt = FakeSilero(), FakeStt()
    settings = Settings(home=tmp_path, warmup=True)
    app = create_app(settings, silero=silero, stt=stt, cache=SpeechCache(tmp_path, 0, False))
    with TestClient(app) as client:
        client.post("/v1/audio/transcriptions", files={"file": ("a.wav", wav_bytes(), "audio/wav")})
    assert stt.loads == 1


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
    catalog = VoiceCatalog.load(SERVICE_DIR / "voices.json", "silero:aidar")
    voices = catalog.list()
    assert all(voice.engine == "silero" for voice in voices)
    # AM7, the system and every crew member speak with a speaker of their own.
    cast = [v for v in voices if v.role in ("system", "lead", "crew")]
    speakers = [v.params["speaker"] for v in cast]
    assert len(speakers) == len(set(speakers)) == 8
    crew = [v for v in voices if v.role == "crew"]
    assert len(crew) == 6 and {v.gender for v in crew} == {"male"} and {v.fx for v in crew} == {"humanoid-hard"}


def test_fx_is_applied_before_caching_and_changes_the_sound(settings):
    silero = FakeSilero()
    client = make_client(settings, silero)
    plain = client.post("/v1/audio/speech", json={"voice": "silero:eugene", "input": "Штаб", "response_format": "wav"})
    treated = client.post("/v1/audio/speech", json={"voice": "silero:system", "input": "Штаб", "response_format": "wav"})
    again = client.post("/v1/audio/speech", json={"voice": "silero:system", "input": "Штаб", "response_format": "wav"})
    assert plain.headers["x-speech-fx"] == "none" and treated.headers["x-speech-fx"] == "humanoid-heavy"
    assert again.headers["x-speech-cache"] == "hit" and again.content == treated.content
    assert treated.content != plain.content
    assert [call[1] for call in silero.calls] == ["eugene", "eugene"]


def test_stress_lexicon_marks_silero(settings):
    silero = FakeSilero()
    stress = StressLexicon(["зам+ок на двер+и", "вс+ё под контр+олем"])
    client = make_client(settings, silero, stress=stress)
    client.post("/v1/audio/speech", json={"voice": "silero:system", "input": "Замок на двери закрыт, все под контролем."})
    assert silero.calls[-1][0] == "Зам+ок на двер+и закрыт, вс+ё под контр+олем."
    assert stress.apply("Все под контролем.", marks=False) == "Всё под контролем."


def test_cis_speakers_resolve_and_bad_presets_are_refused():
    from speech_gateway.voices import parse_preset

    catalog = VoiceCatalog([], "silero:aidar")
    assert catalog.resolve("silero:ru_roman").params == {"speaker": "ru_roman"}
    with pytest.raises(ValueError):
        parse_preset({"id": "silero:x", "params": {"speaker": "eugene"}, "fx": "robot"})
    with pytest.raises(ValueError):
        parse_preset({"id": "silero:y", "params": {"speaker": "nobody"}})
    with pytest.raises(ValueError):
        parse_preset({"id": "voicestudio:z", "params": {"speaker": "eugene"}})


def test_a_new_reading_of_the_text_is_not_served_from_the_old_cache(settings):
    silero = FakeSilero()
    silero.text_version = "2:aaa"
    client = make_client(settings, silero)
    body = {"voice": "silero:aidar", "input": "Время — 06:40.", "response_format": "wav"}
    assert client.post("/v1/audio/speech", json=body).headers["x-speech-cache"] == "miss"
    assert client.post("/v1/audio/speech", json=body).headers["x-speech-cache"] == "hit"
    silero.text_version = "3:aaa"  # the normalisation or a lexicon changed
    assert client.post("/v1/audio/speech", json=body).headers["x-speech-cache"] == "miss"
