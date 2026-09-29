"""Audio containers for the OpenAI `response_format` values.

Every engine hands back mono float32 samples; this module turns them into the
requested container with libsndfile (MP3 needs libsndfile 1.1+, which the
soundfile wheels bundle), so no ffmpeg is needed.
"""

from __future__ import annotations

import io
from dataclasses import dataclass

import numpy as np
import soundfile as sf

FORMATS = ("mp3", "wav", "opus", "flac", "pcm")

MEDIA_TYPES = {
    "mp3": "audio/mpeg",
    "wav": "audio/wav",
    "opus": "audio/ogg",
    "flac": "audio/flac",
    "pcm": "audio/pcm",
}

#: OpenAI's `pcm` is raw 24 kHz 16-bit little-endian mono.
PCM_RATE = 24_000
_MP3_RATES = (8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000)
_OPUS_RATES = (8000, 12000, 16000, 24000, 48000)


@dataclass
class Audio:
    samples: np.ndarray  # mono float32 in [-1, 1]
    sample_rate: int

    @property
    def duration_s(self) -> float:
        return len(self.samples) / float(self.sample_rate) if self.sample_rate else 0.0


def as_mono_float32(samples: np.ndarray) -> np.ndarray:
    data = np.asarray(samples, dtype=np.float32)
    if data.ndim == 2:
        data = data.mean(axis=1) if data.shape[1] <= 8 else data.mean(axis=0)
    return np.clip(data.reshape(-1), -1.0, 1.0)


def concat(parts: list[np.ndarray], sample_rate: int, gap_s: float = 0.12) -> np.ndarray:
    if not parts:
        return np.zeros(0, dtype=np.float32)
    gap = np.zeros(int(sample_rate * gap_s), dtype=np.float32)
    out: list[np.ndarray] = []
    for index, part in enumerate(parts):
        if index:
            out.append(gap)
        out.append(as_mono_float32(part))
    return np.concatenate(out)


def resample(samples: np.ndarray, source_rate: int, target_rate: int) -> np.ndarray:
    """Band-limited linear-phase resampling (windowed sinc low-pass + interpolation).

    Good enough for speech; avoids a scipy/torchaudio dependency.
    """
    if source_rate == target_rate or len(samples) == 0:
        return samples.astype(np.float32)
    data = samples.astype(np.float64)
    if target_rate < source_rate:
        cutoff = 0.5 * target_rate / source_rate * 0.95
        taps = 63
        n = np.arange(taps) - (taps - 1) / 2
        kernel = 2 * cutoff * np.sinc(2 * cutoff * n) * np.hamming(taps)
        kernel /= kernel.sum()
        data = np.convolve(data, kernel, mode="same")
    duration = len(data) / source_rate
    target_len = max(1, int(round(duration * target_rate)))
    positions = np.linspace(0, len(data) - 1, target_len)
    return np.interp(positions, np.arange(len(data)), data).astype(np.float32)


def _nearest(rate: int, allowed: tuple[int, ...]) -> int:
    return rate if rate in allowed else min(allowed, key=lambda r: (abs(r - rate), -r))


def encode(audio: Audio, fmt: str) -> bytes:
    if fmt not in FORMATS:
        raise ValueError(f"unsupported response_format: {fmt}")
    samples = as_mono_float32(audio.samples)
    rate = audio.sample_rate
    if fmt == "pcm":
        pcm = resample(samples, rate, PCM_RATE)
        return (np.clip(pcm, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
    buffer = io.BytesIO()
    if fmt == "wav":
        sf.write(buffer, samples, rate, format="WAV", subtype="PCM_16")
    elif fmt == "flac":
        sf.write(buffer, samples, rate, format="FLAC", subtype="PCM_16")
    elif fmt == "mp3":
        target = _nearest(rate, _MP3_RATES)
        sf.write(buffer, resample(samples, rate, target), target, format="MP3", subtype="MPEG_LAYER_III")
    elif fmt == "opus":
        target = _nearest(rate, _OPUS_RATES)
        sf.write(buffer, resample(samples, rate, target), target, format="OGG", subtype="OPUS")
    return buffer.getvalue()


def decode(data: bytes) -> Audio:
    samples, rate = sf.read(io.BytesIO(data), dtype="float32", always_2d=False)
    return Audio(as_mono_float32(samples), int(rate))


class UndecodableAudio(ValueError):
    """The upload is not audio this gateway can read."""


def _decode_av(data: bytes, rate: int) -> np.ndarray:
    """Any container FFmpeg reads (WebM/Opus from Chrome, MP4/AAC from Safari),
    through PyAV's bundled FFmpeg, straight to mono float32 at `rate`."""
    try:
        import av  # noqa: PLC0415 - optional: only uploads libsndfile cannot read need it
    except ImportError as exc:
        raise UndecodableAudio("this audio container needs PyAV (pip install av)") from exc
    parts: list[np.ndarray] = []
    try:
        with av.open(io.BytesIO(data), mode="r") as container:
            if not container.streams.audio:
                raise UndecodableAudio("the file has no audio stream")
            stream = container.streams.audio[0]
            resampler = av.AudioResampler(format="flt", layout="mono", rate=rate)
            for frame in container.decode(stream):
                for out in resampler.resample(frame):
                    parts.append(out.to_ndarray().reshape(-1))
            for out in resampler.resample(None):
                parts.append(out.to_ndarray().reshape(-1))
    except UndecodableAudio:
        raise
    except Exception as exc:  # av.error.* — corrupt or unsupported input
        raise UndecodableAudio(f"could not decode the audio ({type(exc).__name__})") from exc
    if not parts:
        return np.zeros(0, dtype=np.float32)
    return np.clip(np.concatenate(parts).astype(np.float32), -1.0, 1.0)


def decode_for_recognition(data: bytes, rate: int = 16_000) -> np.ndarray:
    """An uploaded recording as mono float32 at `rate` (16 kHz for recognition).

    WAV, FLAC, Ogg/Opus and MP3 go through libsndfile; WebM, MP4 and the rest
    through PyAV.
    """
    try:
        audio = decode(data)
    except Exception:
        return _decode_av(data, rate)
    return resample(audio.samples, audio.sample_rate, rate)
