"""The GigaAM engine's own logic, with onnx-asr and onnxruntime mocked."""

from __future__ import annotations

import io
import sys
import types

import numpy as np
import pytest
import soundfile as sf

from speech_gateway.audio import UndecodableAudio, decode_for_recognition
from speech_gateway.config import Settings
from speech_gateway.stt_engine import RATE, GigaAMEngine


class FakeAsr:
    def __init__(self) -> None:
        self.spans: list[int] = []

    def recognize(self, wave: np.ndarray) -> str:
        self.spans.append(len(wave))
        return "  Привет,   штаб.  " if np.abs(wave).max(initial=0) > 0.01 else ""


class FakeVad:
    """Speech wherever the signal is loud, or the segments a test sets."""

    def __init__(self) -> None:
        self.fixed: list[tuple[int, int]] | None = None

    def segment_batch(self, waves, lens, rate, **kwargs):
        assert rate == RATE and waves.shape[0] == 1
        if self.fixed is not None:
            yield iter(self.fixed)
            return
        block = 160  # 10 ms
        wave = waves[0][: len(waves[0]) // block * block]
        loud = np.abs(wave.reshape(-1, block)).max(axis=1) > 0.05
        edges = np.flatnonzero(np.diff(np.concatenate([[0], loud.astype(np.int8), [0]]))) * block
        yield iter(list(zip(edges[::2], edges[1::2])))


@pytest.fixture
def fake_onnx(monkeypatch):
    calls = {"load_model": [], "load_vad": 0}
    asr, vad = FakeAsr(), FakeVad()
    onnx_asr = types.ModuleType("onnx_asr")

    def load_model(name, path=None, **kwargs):
        calls["load_model"].append((name, path, kwargs.get("quantization"), kwargs.get("providers")))
        return asr

    def load_vad(name="silero", **kwargs):
        calls["load_vad"] += 1
        return vad

    onnx_asr.load_model = load_model
    onnx_asr.load_vad = load_vad
    ort = types.ModuleType("onnxruntime")

    class SessionOptions:
        intra_op_num_threads = 0
        inter_op_num_threads = 0

    ort.SessionOptions = SessionOptions
    monkeypatch.setitem(sys.modules, "onnx_asr", onnx_asr)
    monkeypatch.setitem(sys.modules, "onnxruntime", ort)
    return types.SimpleNamespace(calls=calls, asr=asr, vad=vad)


def tone(seconds: float, amp: float = 0.3) -> np.ndarray:
    t = np.arange(int(seconds * RATE)) / RATE
    return (amp * np.sin(2 * np.pi * 220 * t)).astype(np.float32)


def silence(seconds: float) -> np.ndarray:
    return np.zeros(int(seconds * RATE), dtype=np.float32)


def wav(samples: np.ndarray, rate: int = RATE) -> bytes:
    buffer = io.BytesIO()
    sf.write(buffer, samples, rate, format="WAV", subtype="PCM_16")
    return buffer.getvalue()


def test_model_is_loaded_once_and_stays_resident(fake_onnx):
    engine = GigaAMEngine(threads=3)
    assert not engine.ready
    for _ in range(3):
        result = engine.transcribe(wav(np.concatenate([silence(0.5), tone(1.0), silence(0.5)])))
        assert result.text == "Привет, штаб."
    assert len(fake_onnx.calls["load_model"]) == 1 and fake_onnx.calls["load_vad"] == 1
    name, path, quantization, providers = fake_onnx.calls["load_model"][0]
    assert name == "gigaam-v3-e2e-rnnt" and path is None and quantization is None
    assert providers == ["CPUExecutionProvider"]
    assert engine.ready and engine.describe()["loaded_in_s"] is not None


def test_vad_trims_the_silence_around_a_command(fake_onnx):
    engine = GigaAMEngine()
    engine.load()
    fake_onnx.asr.spans.clear()
    result = engine.recognize(np.concatenate([silence(1.0), tone(1.5), silence(1.0)]))
    assert fake_onnx.asr.spans == [int(1.5 * RATE)]
    assert result.segments[0].start == 1.0 and result.segments[0].end == 2.5
    assert result.duration_s == pytest.approx(3.5)


def test_noise_free_silence_gives_no_text_and_no_model_call(fake_onnx):
    engine = GigaAMEngine()
    engine.load()
    fake_onnx.asr.spans.clear()
    assert engine.recognize(silence(2.0)).text == ""
    assert engine.recognize(silence(0.05)).text == ""
    assert fake_onnx.asr.spans == []


def test_long_speech_is_cut_at_pauses_into_model_sized_spans(fake_onnx):
    engine = GigaAMEngine(max_span_s=20.0)
    engine.load()
    fake_onnx.asr.spans.clear()
    s = RATE
    fake_onnx.vad.fixed = [(0, 10 * s), (11 * s, 19 * s), (21 * s, 30 * s)]
    result = engine.recognize(tone(30.0))
    assert fake_onnx.asr.spans == [19 * s, 9 * s]
    assert [(seg.start, seg.end) for seg in result.segments] == [(0.0, 19.0), (21.0, 30.0)]
    assert result.text == "Привет, штаб. Привет, штаб."


def test_without_vad_the_whole_recording_is_read(fake_onnx):
    engine = GigaAMEngine(vad=False, quantization="int8")
    engine.load()
    fake_onnx.asr.spans.clear()
    engine.recognize(tone(3.0))
    assert fake_onnx.asr.spans == [3 * RATE] and fake_onnx.calls["load_vad"] == 0
    assert fake_onnx.calls["load_model"][0][2] == "int8"
    assert engine.describe()["model"] == "gigaam-v3-e2e-rnnt:int8"


def test_failed_load_is_reported_and_retried(fake_onnx, monkeypatch):
    def broken(*args, **kwargs):
        raise OSError("no weights")

    monkeypatch.setattr(sys.modules["onnx_asr"], "load_model", broken)
    engine = GigaAMEngine()
    with pytest.raises(OSError):
        engine.load()
    assert not engine.ready and "no weights" in engine.describe()["error"]


def test_unknown_model_is_refused():
    with pytest.raises(ValueError):
        GigaAMEngine(model="whisper-large-v3")


def test_decoding_resamples_to_16k():
    samples = tone(1.0)
    at48 = np.interp(np.linspace(0, len(samples) - 1, 48_000), np.arange(len(samples)), samples).astype(np.float32)
    out = decode_for_recognition(wav(at48, 48_000))
    assert out.dtype == np.float32 and abs(len(out) - RATE) <= 2


def test_decoding_webm_opus_from_a_browser():
    av = pytest.importorskip("av")
    buffer = io.BytesIO()
    container = av.open(buffer, mode="w", format="webm")
    stream = container.add_stream("libopus", rate=48_000)
    stream.layout = "mono"
    pcm = (tone(1.0, 0.3).repeat(3) * 32767).astype(np.int16)
    for start in range(0, len(pcm), 960):
        chunk = pcm[start:start + 960]
        chunk = np.pad(chunk, (0, 960 - len(chunk)))
        frame = av.AudioFrame.from_ndarray(chunk.reshape(1, -1), format="s16", layout="mono")
        frame.sample_rate = 48_000
        for packet in stream.encode(frame):
            container.mux(packet)
    for packet in stream.encode(None):
        container.mux(packet)
    container.close()
    out = decode_for_recognition(buffer.getvalue())
    assert abs(len(out) / RATE - 1.0) < 0.1 and np.abs(out).max() > 0.1


def test_garbage_is_undecodable():
    with pytest.raises(UndecodableAudio):
        decode_for_recognition(b"definitely not audio" * 10)


def test_stt_settings_from_env(monkeypatch, tmp_path):
    monkeypatch.setenv("SPEECH_STT_ENGINE", "VoiceStudio")
    monkeypatch.setenv("SPEECH_STT_QUANTIZATION", "INT8")
    monkeypatch.setenv("SPEECH_STT_THREADS", "0")
    monkeypatch.setenv("SPEECH_STT_MODEL_DIR", str(tmp_path))
    monkeypatch.setenv("SPEECH_VOICESTUDIO_WARMUP", "0")
    settings = Settings.from_env()
    assert settings.stt_engine == "voicestudio" and settings.stt_quantization == "int8"
    assert settings.stt_threads == 1 and settings.stt_model_dir == tmp_path
    assert settings.voicestudio_warmup is False
    monkeypatch.setenv("SPEECH_STT_ENGINE", "nonsense")
    assert Settings.from_env().stt_engine == "gigaam"
