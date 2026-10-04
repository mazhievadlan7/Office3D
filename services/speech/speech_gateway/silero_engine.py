"""Silero TTS v5 (Russian) with silero-stress placing word stress and ё.

The model is a torch package downloaded once into the models directory. The
stress model marks every word (`гот+ов`, homographs by context); the TTS model
then reads the marks as written, with its own accenting switched off, so the
stress we computed is the stress you hear. Long text is spoken sentence by
sentence (Silero has a per-call length limit) and joined with short pauses.

Two model files: the main Russian model (v5_5_ru: aidar, eugene) and
the CIS model (v5_cis_base, MIT: its male speakers, ru_roman, ru_safarhuja, …), which gives the
crew's fallback voices distinct timbres. The CIS model loads the first time
one of its speakers talks.
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
from .text import TEXT_VERSION, chunk_text, lexicon_version, load_lexicon, normalize_russian, ssml_rate
from .voices import ALL_SILERO_SPEAKERS, is_cis_speaker

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
        cis_model: str = "v5_cis_base",
        lexicon_local_file: Path | None = None,
    ) -> None:
        self.model_id = model
        self.cis_model_id = cis_model
        self._model_url = model_url
        self.model_url = model_url.format(model=model)
        self.models_dir = models_dir
        self.model_path = models_dir / "silero" / f"{model}.pt"
        self.requested_device = device
        self.threads = threads
        self.sample_rate = sample_rate
        self.lexicon = load_lexicon(lexicon_file, lexicon_local_file)
        #: How this engine turns text into what it reads (part of the cache key):
        #: a change to the normalisation or to a lexicon renders the line anew.
        self.text_version = f"{TEXT_VERSION}:{lexicon_version(self.lexicon)}"
        self._lock = threading.Lock()  # the model is not re-entrant
        self._model: Any = None
        self._cis: Any = None
        self._accentor: Any = None
        self.device = "cpu"
        self.error: str | None = None
        self.loaded_in_s: float | None = None

    @property
    def ready(self) -> bool:
        return self._model is not None

    def speakers(self) -> tuple[str, ...]:
        return ALL_SILERO_SPEAKERS

    def model_for(self, speaker: str) -> str:
        """The model file that speaks `speaker` (part of the cache identity)."""
        return self.cis_model_id if is_cis_speaker(speaker) else self.model_id

    def describe(self) -> dict[str, Any]:
        return {
            "ready": self.ready,
            "model": self.model_id,
            "device": self.device,
            "sample_rate": self.sample_rate,
            "loaded_in_s": self.loaded_in_s,
            "cis_model": self.cis_model_id,
            "cis_loaded": self._cis is not None,
            "error": self.error,
        }

    def _download(self, model: str | None = None) -> Path:
        model = model or self.model_id
        path = self.models_dir / "silero" / f"{model}.pt"
        if path.is_file() and path.stat().st_size > 1_000_000:
            return path
        path.parent.mkdir(parents=True, exist_ok=True)
        partial = path.with_suffix(".part")
        log.info("downloading Silero %s", model)
        urllib.request.urlretrieve(self._model_url.format(model=model), partial)  # noqa: S310 - fixed https URL
        partial.replace(path)
        return path

    def _import(self, path: Path) -> Any:
        import torch

        importer = torch.package.PackageImporter(str(path))
        model = importer.load_pickle("tts_models", "model")
        model.to(torch.device(self.device))
        return model

    def load_cis(self) -> None:
        """The CIS model (downloaded on first use, ~90 MB)."""
        if self._model is None:
            self.load()
        with self._lock:
            if self._cis is not None:
                return
            started = time.perf_counter()
            self._cis = self._import(self._download(self.cis_model_id))
            log.info("Silero %s ready in %.1fs", self.cis_model_id, time.perf_counter() - started)

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
                self.device = device
                model = self._import(self.model_path)
                accentor = load_accentor()
                self._accentor = accentor
                self._model = model
                self.error = None
                # One short phrase so the first real request is not the slow one.
                self._synth_chunk(self._model, "Готов+о.", "aidar", None)
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

    def _synth_chunk(self, model: Any, marked: str, speaker: str, rate: str | None) -> np.ndarray:
        kwargs = dict(
            speaker=speaker,
            sample_rate=self.sample_rate,
            put_accent=False,
            put_yo=False,
            put_stress_homo=False,
            put_yo_homo=False,
        )
        if rate:
            audio = model.apply_tts(ssml_text=f'<speak><prosody rate="{rate}">{marked}</prosody></speak>', **kwargs)
        else:
            audio = model.apply_tts(text=marked, **kwargs)
        return audio.detach().cpu().numpy().astype(np.float32)

    def synthesize(self, text: str, speaker: str, speed: float = 1.0) -> Audio:
        if speaker not in ALL_SILERO_SPEAKERS:
            raise ValueError(f"unknown Silero speaker {speaker!r}")
        if self._model is None:
            self.load()
        if is_cis_speaker(speaker) and self._cis is None:
            self.load_cis()
        with self._lock:
            model = self._cis if is_cis_speaker(speaker) else self._model
            chunks = self.prepare_text(text)
            if not chunks:
                raise ValueError("nothing speakable in the input")
            rate = ssml_rate(speed)
            parts = [self._synth_chunk(model, chunk, speaker, rate) for chunk in chunks]
        return Audio(concat(parts, self.sample_rate), self.sample_rate)
