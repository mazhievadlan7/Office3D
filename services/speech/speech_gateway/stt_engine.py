"""Russian speech recognition inside the gateway: GigaAM v3 on the CPU.

GigaAM v3 (salute-developers/GigaAM, MIT) runs through onnx-asr (MIT) and
ONNX Runtime; the default `gigaam-v3-e2e-rnnt` writes punctuation and
capitals itself. Silero VAD (MIT, also through onnx-asr) trims the silence
around a command, so a recording of only noise gives an empty text instead of
an invented phrase, and splits long recordings into spans the model takes in
one pass.

The model is loaded once (at start-up when warm-up is on) and stays in memory;
a request never reloads it. It runs on the CPU on purpose: the GPU belongs to
VoiceStudio's VoxCPM2, and GigaAM on a few CPU cores is far faster than real
time (about 0.2 s for a 3 s command).

Weights come from the Hugging Face hub (istupakov/gigaam-v3-onnx,
istupakov/silero-vad-onnx) into HF_HOME, or from SPEECH_STT_MODEL_DIR.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from .audio import decode_for_recognition

log = logging.getLogger("speech.stt")

RATE = 16_000

#: Models this engine accepts (onnx-asr names). All are Russian-only.
GIGAAM_MODELS = (
    "gigaam-v3-e2e-rnnt",
    "gigaam-v3-e2e-ctc",
    "gigaam-v3-rnnt",
    "gigaam-v3-ctc",
)


@dataclass
class Segment:
    start: float
    end: float
    text: str


@dataclass
class Transcript:
    text: str
    duration_s: float
    segments: list[Segment] = field(default_factory=list)
    language: str = "ru"


class GigaAMEngine:
    name = "gigaam"

    def __init__(
        self,
        *,
        model: str = "gigaam-v3-e2e-rnnt",
        quantization: str = "",
        threads: int = 4,
        vad: bool = True,
        model_dir: Path | None = None,
        max_span_s: float = 20.0,
    ) -> None:
        if model not in GIGAAM_MODELS:
            raise ValueError(f"unknown GigaAM model {model!r}; one of {', '.join(GIGAAM_MODELS)}")
        self.model_id = model
        self.quantization = quantization or None
        self.threads = max(1, threads)
        self.use_vad = vad
        self.model_dir = model_dir
        #: GigaAM takes a whole span at once; longer speech is cut at pauses.
        self.max_span_s = max_span_s
        self._lock = threading.Lock()
        self._asr: Any = None
        self._vad: Any = None
        self.error: str | None = None
        self.loaded_in_s: float | None = None
        #: True while the first load (possibly a ~0.9 GB download) runs.
        self.loading = False

    @property
    def ready(self) -> bool:
        return self._asr is not None

    def describe(self) -> dict[str, Any]:
        return {
            "engine": self.name,
            "ready": self.ready,
            "model": self.model_id + (f":{self.quantization}" if self.quantization else ""),
            "device": "cpu",
            "threads": self.threads,
            "vad": self.use_vad,
            "loading": self.loading,
            "loaded_in_s": self.loaded_in_s,
            "error": self.error,
        }

    def load(self) -> None:
        with self._lock:
            if self._asr is not None:
                return
            started = time.perf_counter()
            self.loading = True
            try:
                import onnx_asr
                import onnxruntime as ort

                options = ort.SessionOptions()
                options.intra_op_num_threads = self.threads
                options.inter_op_num_threads = 1
                providers = ["CPUExecutionProvider"]
                asr = onnx_asr.load_model(
                    self.model_id,
                    str(self.model_dir) if self.model_dir else None,
                    quantization=self.quantization,
                    sess_options=options,
                    providers=providers,
                )
                vad = onnx_asr.load_vad("silero", sess_options=options, providers=providers) if self.use_vad else None
                # One pass through both so the first real command is not the slow one.
                asr.recognize(np.zeros(RATE, dtype=np.float32))
                if vad is not None:
                    list(self._segments_with(vad, np.zeros(RATE, dtype=np.float32)))
                self._asr, self._vad = asr, vad
                self.error = None
                self.loaded_in_s = round(time.perf_counter() - started, 2)
                log.info("GigaAM %s ready on cpu (%d threads) in %.1fs", self.describe()["model"], self.threads, self.loaded_in_s)
            except Exception as exc:  # reported by /health; the next request retries
                self._asr = self._vad = None
                self.error = f"{type(exc).__name__}: {exc}"
                log.exception("GigaAM failed to load")
                raise
            finally:
                self.loading = False

    def _segments_with(self, vad: Any, wave: np.ndarray) -> list[tuple[int, int]]:
        batches = vad.segment_batch(
            wave[None, :],
            np.array([len(wave)], dtype=np.int64),
            RATE,
            threshold=0.4,
            min_speech_duration_ms=150,
            min_silence_duration_ms=400,
            speech_pad_ms=250,
            max_speech_duration_s=self.max_span_s,
        )
        return [(int(s), int(e)) for s, e in next(iter(batches))]

    def spans(self, wave: np.ndarray) -> list[tuple[int, int]]:
        """Where to recognise: the speech (by VAD), as few spans as fit the model."""
        limit = int(self.max_span_s * RATE)
        if self._vad is None:
            return [(start, min(start + limit, len(wave))) for start in range(0, len(wave), limit)]
        spans: list[tuple[int, int]] = []
        for start, end in self._segments_with(self._vad, wave):
            if spans and end - spans[-1][0] <= limit:
                spans[-1] = (spans[-1][0], end)  # one pass keeps the phrase's context
            else:
                spans.append((start, end))
        return spans

    def recognize(self, wave: np.ndarray) -> Transcript:
        """Mono float32 at 16 kHz to text."""
        if self._asr is None:
            self.load()
        duration = len(wave) / RATE
        if len(wave) < RATE // 10:
            return Transcript("", duration)
        with self._lock:
            segments = []
            for start, end in self.spans(wave):
                text = " ".join(str(self._asr.recognize(wave[start:end])).split())
                if text:
                    segments.append(Segment(round(start / RATE, 3), round(end / RATE, 3), text))
        return Transcript(" ".join(s.text for s in segments), duration, segments)

    def transcribe(self, data: bytes) -> Transcript:
        """An uploaded recording (WAV, WebM/Opus, Ogg, MP3, MP4, …) to text."""
        return self.recognize(decode_for_recognition(data, RATE))
