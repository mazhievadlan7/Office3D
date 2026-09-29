"""Per-voice post-processing ("humanoid AI" treatment), applied after synthesis.

A voice preset names an `fx` preset (voices.json); the gateway runs it on the
rendered speech before encoding and caching, so every client hears the same
final sound and none has to process it again. numpy only (no scipy, no
ffmpeg), deterministic (same input, same output, on any CPU).

The chain mirrors the one auditioned with ffmpeg (rubberband pitch shift with
formants shifted, a light flanger, a short echo, a high-pass, a limiter):

1. pitch shift keeping the tempo: WSOLA time-compression, then windowed-sinc
   resampling back to the original length (formants move with the pitch, so
   the voice sounds bigger and darker, not chipmunk-like);
2. a light flanger: the voice plus a copy delayed by 1–2 ms, the delay swept
   slowly (a faint metallic, synthetic sheen);
3. a short echo (two early reflections: a small hard room);
4. a zero-phase high-pass (rumble below ~70 Hz);
5. loudness: active speech to a fixed RMS, peaks softly limited, so every
   voice arrives at the same level.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .audio import Audio

#: Bumped whenever the processing changes, so cached speech is rendered again.
FX_VERSION = "fx1"


@dataclass(frozen=True)
class FxPreset:
    semitones: float
    flanger_mix: float
    flanger_delay_ms: float
    flanger_depth_ms: float
    flanger_rate_hz: float
    #: (delay seconds, gain) reflections added to the voice.
    echoes: tuple[tuple[float, float], ...]
    highpass_hz: float = 70.0
    #: RMS of the active speech (dBFS) and the soft ceiling for peaks (linear).
    target_rms_db: float = -19.0
    ceiling: float = 0.94


FX_PRESETS: dict[str, FxPreset | None] = {
    "none": None,
    # «Система штаба» and AM7: two semitones down, a light flanger, a short echo.
    "humanoid": FxPreset(
        semitones=-2.0,
        flanger_mix=0.30,
        flanger_delay_ms=1.0,
        flanger_depth_ms=1.0,
        flanger_rate_hz=0.25,
        echoes=((0.023, 0.18), (0.041, 0.10)),
    ),
    # The crew: one semitone down, a subtler flanger, a faint room.
    "humanoid-light": FxPreset(
        semitones=-1.0,
        flanger_mix=0.16,
        flanger_delay_ms=1.0,
        flanger_depth_ms=0.7,
        flanger_rate_hz=0.2,
        echoes=((0.019, 0.09), (0.033, 0.05)),
    ),
}


def is_fx_preset(name: str | None) -> bool:
    return (name or "none") in FX_PRESETS


def apply_fx(audio: Audio, preset: str | None) -> Audio:
    """The treated audio, or `audio` itself for "none" (or no preset)."""
    fx = FX_PRESETS.get(preset or "none")
    if fx is None or len(audio.samples) == 0:
        return audio
    sr = audio.sample_rate
    x = np.asarray(audio.samples, dtype=np.float64).reshape(-1)
    if fx.semitones:
        x = pitch_shift(x, sr, fx.semitones)
    if fx.flanger_mix > 0:
        x = flanger(x, sr, fx.flanger_mix, fx.flanger_delay_ms, fx.flanger_depth_ms, fx.flanger_rate_hz)
    if fx.echoes:
        x = echo(x, sr, fx.echoes)
    if fx.highpass_hz > 0:
        x = highpass(x, sr, fx.highpass_hz)
    x = level(x, sr, fx.target_rms_db, fx.ceiling)
    return Audio(x.astype(np.float32), sr)


# --- building blocks -----------------------------------------------------------------


def wsola(x: np.ndarray, sr: int, speed: float) -> np.ndarray:
    """Time-scale `x` by 1/speed (speed > 1: shorter) without changing its pitch.

    Waveform-similarity overlap-add: 30 ms Hann frames at 50 % overlap; each
    frame is taken from within ±10 ms of its nominal place, where it best
    continues the previous one (cross-correlation), so periods line up.
    """
    n = len(x)
    if n == 0 or speed == 1.0:
        return x.copy()
    frame = int(round(0.030 * sr)) // 2 * 2
    hop = frame // 2
    tol = int(round(0.010 * sr))
    window = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(frame) / frame)  # periodic Hann: sums to 1 at 50 %
    n_out = max(1, int(round(n / speed)))
    frames = n_out // hop + 2
    lead = hop + tol
    padded = np.concatenate([np.zeros(lead), x, np.zeros(frame + 2 * tol + int(frames * hop * speed) - n + hop)])
    out = np.zeros(frames * hop + frame)
    fft_n = 1 << int(np.ceil(np.log2(frame + 2 * tol + frame)))
    previous = -1
    for k in range(frames):
        nominal = tol + int(round(k * hop * speed))
        if previous < 0:
            start = nominal
        else:
            template = padded[previous + hop : previous + hop + frame]
            lo = nominal - tol
            region = padded[lo : nominal + tol + frame]
            spectrum = np.fft.rfft(region, fft_n) * np.conj(np.fft.rfft(template, fft_n))
            corr = np.fft.irfft(spectrum, fft_n)[: len(region) - frame + 1]
            start = lo + int(np.argmax(corr))
        out[k * hop : k * hop + frame] += padded[start : start + frame] * window
        previous = start
    return out[hop : hop + n_out]


def resample_to(x: np.ndarray, length: int, half_taps: int = 16) -> np.ndarray:
    """`x` stretched or squeezed to `length` samples by windowed-sinc interpolation."""
    if length <= 0 or len(x) == 0:
        return np.zeros(max(0, length))
    ratio = len(x) / length  # input samples per output sample
    cutoff = min(1.0, 1.0 / ratio)
    positions = np.arange(length) * ratio
    padded = np.concatenate([np.zeros(half_taps), x, np.zeros(half_taps + 1)])
    offsets = np.arange(-half_taps + 1, half_taps + 1)
    out = np.empty(length)
    step = 8192
    for begin in range(0, length, step):
        p = positions[begin : begin + step]
        base = np.floor(p).astype(np.int64)
        idx = base[:, None] + offsets[None, :]
        t = p[:, None] - idx
        kernel = cutoff * np.sinc(cutoff * t) * (0.5 + 0.5 * np.cos(np.pi * np.clip(t / half_taps, -1, 1)))
        values = padded[np.clip(idx + half_taps, 0, len(padded) - 1)]
        out[begin : begin + step] = np.sum(values * kernel, axis=1)
    return out


def pitch_shift(x: np.ndarray, sr: int, semitones: float) -> np.ndarray:
    """Pitch moved by `semitones`, duration kept (formants move with it)."""
    ratio = 2.0 ** (semitones / 12.0)  # < 1 lowers
    squeezed = wsola(x, sr, 1.0 / ratio)  # duration * ratio, same pitch
    return resample_to(squeezed, len(x))  # back to the duration: pitch * ratio


def _delayed(x: np.ndarray, delay: np.ndarray) -> np.ndarray:
    """x(t - delay(t)) with linear interpolation (delay in samples, >= 0)."""
    position = np.arange(len(x)) - delay
    base = np.floor(position).astype(np.int64)
    frac = position - base
    padded = np.concatenate([np.zeros(1), x, np.zeros(1)])
    a = padded[np.clip(base + 1, 0, len(padded) - 1)]
    b = padded[np.clip(base + 2, 0, len(padded) - 1)]
    return np.where(position >= 0, a * (1 - frac) + b * frac, 0.0)


def flanger(x: np.ndarray, sr: int, mix: float, delay_ms: float, depth_ms: float, rate_hz: float) -> np.ndarray:
    t = np.arange(len(x)) / sr
    sweep = 0.5 - 0.5 * np.cos(2 * np.pi * rate_hz * t)
    delay = (delay_ms + depth_ms * sweep) * sr / 1000.0
    return (x + mix * _delayed(x, delay)) / (1.0 + mix)


def echo(x: np.ndarray, sr: int, taps: tuple[tuple[float, float], ...]) -> np.ndarray:
    tail = int(round(max(d for d, _ in taps) * sr))
    out = np.concatenate([x, np.zeros(tail)])
    for delay_s, gain in taps:
        d = int(round(delay_s * sr))
        out[d : d + len(x)] += gain * x
    return out


def highpass(x: np.ndarray, sr: int, cutoff_hz: float) -> np.ndarray:
    """Zero-phase high-pass with a 4th-order Butterworth magnitude, in one FFT."""
    pad = int(0.05 * sr)
    n = len(x) + 2 * pad
    size = 1 << int(np.ceil(np.log2(n)))
    spectrum = np.fft.rfft(np.concatenate([np.zeros(pad), x, np.zeros(pad)]), size)
    freqs = np.fft.rfftfreq(size, 1.0 / sr)
    with np.errstate(divide="ignore"):
        gain = 1.0 / np.sqrt(1.0 + (cutoff_hz / np.maximum(freqs, 1e-9)) ** 8)
    gain[0] = 0.0
    return np.fft.irfft(spectrum * gain, size)[pad : pad + len(x)]


def level(x: np.ndarray, sr: int, target_rms_db: float, ceiling: float) -> np.ndarray:
    """Active speech to `target_rms_db`, then a soft knee so peaks stay under `ceiling`."""
    block = max(1, int(0.02 * sr))
    usable = len(x) // block * block
    if usable == 0:
        return x
    rms = np.sqrt(np.mean(x[:usable].reshape(-1, block) ** 2, axis=1))
    loudest = float(rms.max())
    if loudest <= 1e-6:
        return x
    active = rms[rms > loudest * 10 ** (-35 / 20)]
    current = float(np.sqrt(np.mean(active**2)))
    y = x * (10 ** (target_rms_db / 20) / current)
    knee = 0.75 * ceiling
    over = np.abs(y) > knee
    if np.any(over):
        mag = np.abs(y[over])
        y[over] = np.sign(y[over]) * (knee + (ceiling - knee) * np.tanh((mag - knee) / (ceiling - knee)))
    return y
