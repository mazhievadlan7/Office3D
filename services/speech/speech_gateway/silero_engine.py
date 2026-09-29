"""Silero TTS v5 (Russian) with silero-stress placing word stress and ё.

The model is a torch package downloaded once into the models directory. The
stress model marks every word (`гот+ов`, homographs by context); the TTS model
then reads the marks as written, with its own accenting switched off, so the
stress we computed is the stress you hear. Long text is spoken sentence by
sentence (Silero has a per-call length limit) and joined with short pauses.
"""

from __future__ import annotations

import logging
import threading
import time
import urllib.request
from pathlib import Path
from typing import Any

import numpy as np

from .audio import Audio, concat
from .text import chunk_text, load_lexicon, normalize_russian, ssml_rate
from .voices import SILERO_SPEAKERS

log = logging.getLogger("speech.silero")


class SileroEngine:
    name = "silero"

    def __init__(
        self,
        *,
        model: str,
        model_url: str,
        models_dir: Path,
        device: str = "cpu",
        threads: int = 4,
        sample_rate: int = 48_000,
        lexicon_file: Path | None = None,
    ) -> None:
        self.model_id = model
        self.model_url = model_url.format(model=model)
        self.model_path = models_dir / "silero" / f"{model}.pt"
        self.requested_device = device
        self.threads = threads
        self.sample_rate = sample_rate
        self.lexicon = load_lexicon(lexicon_file)
        self._lock = threading.Lock()  # the model is not re-entrant
        self._model: Any = None
        self._accentor: Any = None
        self.device = "cpu"
        self.error: str | None = None
        self.loaded_in_s: float | None = None

    @property
    def ready(self) -> bool:
        return self._model is not None

    def speakers(self) -> tuple[str, ...]:
        return SILERO_SPEAKERS

    def describe(self) -> dict[str, Any]:
        return {
            "ready": self.ready,
            "model": self.model_id,
            "device": self.device,
            "sample_rate": self.sample_rate,
            "loaded_in_s": self.loaded_in_s,
            "error": self.error,
        }

    def _download(self) -> None:
        if self.model_path.is_file() and self.model_path.stat().st_size > 1_000_000:
            return
        self.model_path.parent.mkdir(parents=True, exist_ok=True)
        partial = self.model_path.with_suffix(".part")
        log.info("downloading Silero %s", self.model_id)
        urllib.request.urlretrieve(self.model_url, partial)  # noqa: S310 - fixed https URL
        partial.replace(self.model_path)

    def load(self) -> None:
        with self._lock:
            if self._model is not None:
                return
            started = time.perf_counter()
            try:
                import torch
                from silero_stress import load_accentor

                torch.set_num_threads(self.threads)
                self._download()
                device = self.requested_device
                if device == "auto":
                    device = "cuda" if torch.cuda.is_available() else "cpu"
                if device == "cuda" and not torch.cuda.is_available():
                    device = "cpu"
                importer = torch.package.PackageImporter(str(self.model_path))
                model = importer.load_pickle("tts_models", "model")
                model.to(torch.device(device))
                accentor = load_accentor()
                self._accentor = accentor
                self._model = model
                self.device = device
                self.error = None
                # One short phrase so the first real request is not the slow one.
                self._synth_chunk("Готов+о.", "aidar", None)
                self.loaded_in_s = round(time.perf_counter() - started, 2)
                log.info("Silero %s ready on %s in %.1fs", self.model_id, device, self.loaded_in_s)
            except Exception as exc:  # reported by /health, retried on next request
                self._model = None
                self.error = f"{type(exc).__name__}: {exc}"
                log.exception("Silero failed to load")
                raise

    def prepare_text(self, text: str) -> list[str]:
        """Normalised, stress-marked chunks (lower case: the model's alphabet)."""
        normalized = normalize_russian(text, self.lexicon)
        chunks = chunk_text(normalized, limit=600)
        if self._accentor is None:
            return [chunk.lower() for chunk in chunks]
        return [self._accentor(chunk).lower() for chunk in chunks]

    def _synth_chunk(self, marked: str, speaker: str, rate: str | None) -> np.ndarray:
        kwargs = dict(
            speaker=speaker,
            sample_rate=self.sample_rate,
            put_accent=False,
            put_yo=False,
            put_stress_homo=False,
            put_yo_homo=False,
        )
        if rate:
            audio = self._model.apply_tts(ssml_text=f'<speak><prosody rate="{rate}">{marked}</prosody></speak>', **kwargs)
        else:
            audio = self._model.apply_tts(text=marked, **kwargs)
        return audio.detach().cpu().numpy().astype(np.float32)

    def synthesize(self, text: str, speaker: str, speed: float = 1.0) -> Audio:
        if speaker not in SILERO_SPEAKERS:
            raise ValueError(f"unknown Silero speaker {speaker!r}")
        if self._model is None:
            self.load()
        with self._lock:
            chunks = self.prepare_text(text)
            if not chunks:
                raise ValueError("nothing speakable in the input")
            rate = ssml_rate(speed)
            parts = [self._synth_chunk(chunk, speaker, rate) for chunk in chunks]
        return Audio(concat(parts, self.sample_rate), self.sample_rate)
