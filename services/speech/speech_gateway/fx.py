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

The heavy presets (`humanoid-heavy`, `humanoid-hard`) add, in this order:
the pitch shift with the formants put back (and lowered a little) by a
cepstral spectral-envelope correction, optionally a slower tempo, a soft
saturation (grit), an octave-down sub layer mixed low, a ring-modulated copy
and a short metallic comb resonance (the synthetic "android" sheen), a light
bit-crushed copy, a tone curve (more chest, the 2–4 kHz consonants kept), and a
tight small-room reverb (a few early reflections plus a seeded 0.1 s tail).
Every stage is off in the older presets, so they sound exactly as before.
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
    # --- the heavy presets only (defaults: off) ---
    #: Where the formants go, in semitones from the original voice; None keeps
    #: the old behaviour (they move with the pitch).
    formant_semitones: float | None = None
    #: Duration factor (> 1: slower, pitch unchanged).
    stretch: float = 1.0
    #: tanh saturation drive (0: off).
    drive: float = 0.0
    #: Octave-down copy, low-passed at `sub_lowpass_hz`, mixed at `sub_mix`.
    sub_mix: float = 0.0
    sub_lowpass_hz: float = 220.0
    #: Ring-modulated copy (carrier `ring_hz`), mixed at `ring_mix`.
    ring_mix: float = 0.0
    ring_hz: float = 40.0
    #: Feedback comb (metallic resonance): delay, feedback, mix.
    comb_ms: float = 0.0
    comb_feedback: float = 0.0
    comb_mix: float = 0.0
    #: Bit-crushed copy: bits, sample-hold length, mix.
    crush_bits: int = 0
    crush_hold: int = 1
    crush_mix: float = 0.0
    #: Tone curve: (Hz, dB) points, interpolated on a log-frequency axis.
    eq: tuple[tuple[float, float], ...] = ()
    #: Small-room tail: length (s) and level of a seeded, decaying noise response.
    reverb_s: float = 0.0
    reverb_mix: float = 0.0


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
    # AM7 (and «Система штаба» if chosen): a menacing android bass. Four
    # semitones down with the formants lowered only one (big, not muffled),
    # 6 % slower, gritty, an octave sub, a ring-mod growl and a metal comb.
    "humanoid-heavy": FxPreset(
        semitones=-4.0,
        formant_semitones=-1.0,
        stretch=1.06,
        drive=2.2,
        sub_mix=0.30,
        sub_lowpass_hz=200.0,
        ring_mix=0.22,
        ring_hz=36.0,
        comb_ms=3.1,
        comb_feedback=0.55,
        comb_mix=0.20,
        crush_bits=9,
        crush_hold=2,
        crush_mix=0.10,
        flanger_mix=0.22,
        flanger_delay_ms=1.2,
        flanger_depth_ms=0.8,
        flanger_rate_hz=0.18,
        echoes=((0.011, 0.16), (0.019, 0.11), (0.029, 0.07)),
        eq=((60, -6.0), (110, 3.5), (220, 2.5), (500, -1.5), (1200, -1.0), (2800, 2.0), (4500, 1.0), (9000, -4.0)),
        reverb_s=0.12,
        reverb_mix=0.10,
        highpass_hz=45.0,
    ),
    # The crew: hard and deep but lighter than AM7, so the words stay quick.
    "humanoid-hard": FxPreset(
        semitones=-3.0,
        formant_semitones=-1.0,
        drive=1.8,
        sub_mix=0.16,
        sub_lowpass_hz=200.0,
        ring_mix=0.15,
        ring_hz=45.0,
        comb_ms=2.6,
        comb_feedback=0.45,
        comb_mix=0.14,
        crush_bits=10,
        crush_hold=2,
        crush_mix=0.07,
        flanger_mix=0.18,
        flanger_delay_ms=1.0,
        flanger_depth_ms=0.7,
        flanger_rate_hz=0.22,
        echoes=((0.009, 0.12), (0.017, 0.08), (0.026, 0.05)),
        eq=((60, -6.0), (120, 2.5), (250, 1.5), (600, -1.5), (2800, 2.0), (4500, 1.0), (9000, -3.0)),
        reverb_s=0.09,
        reverb_mix=0.07,
        highpass_hz=55.0,
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
    if fx.formant_semitones is not None or fx.stretch != 1.0:
        x = shift_voice(x, sr, fx.semitones, fx.formant_semitones, fx.stretch)
    elif fx.semitones:
        x = pitch_shift(x, sr, fx.semitones)
    if fx.drive > 0:
        x = saturate(x, fx.drive)
    layers = x.copy()
    if fx.sub_mix > 0:
        layers += fx.sub_mix * lowpass(pitch_shift(x, sr, -12.0), sr, fx.sub_lowpass_hz)
    if fx.ring_mix > 0:
        layers += fx.ring_mix * x * np.sin(2 * np.pi * fx.ring_hz * np.arange(len(x)) / sr)
    if fx.comb_mix > 0:
        layers += fx.comb_mix * comb(x, sr, fx.comb_ms, fx.comb_feedback)
    if fx.crush_mix > 0:
        layers += fx.crush_mix * crush(x, fx.crush_bits, fx.crush_hold)
    x = layers
    if fx.eq:
        x = tone(x, sr, fx.eq)
    if fx.flanger_mix > 0:
        x = flanger(x, sr, fx.flanger_mix, fx.flanger_delay_ms, fx.flanger_depth_ms, fx.flanger_rate_hz)
    if fx.echoes:
        x = echo(x, sr, fx.echoes)
    if fx.reverb_mix > 0:
        x = room(x, sr, fx.reverb_s, fx.reverb_mix)
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


def _frames(sr: int) -> tuple[int, int]:
    size = 1 << int(round(np.log2(0.043 * sr)))  # 2048 at 48 kHz
    return size, size // 4


def _stft(x: np.ndarray, size: int, hop: int) -> np.ndarray:
    window = np.hanning(size + 1)[:-1]
    padded = np.concatenate([np.zeros(size), x, np.zeros(size + hop)])
    count = (len(padded) - size) // hop + 1
    idx = np.arange(size)[None, :] + hop * np.arange(count)[:, None]
    return np.fft.rfft(padded[idx] * window, axis=1)


def _istft(spec: np.ndarray, size: int, hop: int, length: int) -> np.ndarray:
    window = np.hanning(size + 1)[:-1]
    frames = np.fft.irfft(spec, size, axis=1) * window
    out = np.zeros(hop * (len(frames) - 1) + size)
    norm = np.zeros_like(out)
    for k, frame in enumerate(frames):
        out[k * hop : k * hop + size] += frame
        norm[k * hop : k * hop + size] += window**2
    out /= np.maximum(norm, 1e-3)
    return out[size : size + length]


def _envelope(mag: np.ndarray, sr: int, size: int) -> np.ndarray:
    """Cepstrally smoothed log spectral envelope of each frame (quefrencies below 1.6 ms)."""
    log_mag = np.log(np.maximum(mag, 1e-7))
    cep = np.fft.irfft(log_mag, size, axis=1)
    keep = max(8, int(0.0016 * sr))
    lifter = np.zeros(size)
    lifter[:keep] = 1.0
    lifter[size - keep + 1 :] = 1.0
    return np.fft.rfft(cep * lifter, axis=1).real


def shift_voice(
    x: np.ndarray, sr: int, semitones: float, formant_semitones: float | None, stretch: float = 1.0
) -> np.ndarray:
    """Pitch by `semitones`, formants by `formant_semitones` (None: with the pitch), duration * `stretch`.

    The resampling shift moves the whole spectrum; each frame is then flattened
    by its own cepstral envelope and given the original frame's envelope,
    warped by the wanted formant shift (gain limited to ±18 dB).
    """
    ratio = 2.0 ** (semitones / 12.0)
    length = max(1, int(round(len(x) * stretch)))
    y = resample_to(wsola(x, sr, 1.0 / (ratio * stretch)), length) if semitones or stretch != 1.0 else x.copy()
    if formant_semitones is None:
        return y
    source = resample_to(wsola(x, sr, 1.0 / stretch), length) if stretch != 1.0 else x
    size, hop = _frames(sr)
    shifted = _stft(y, size, hop)
    original = _stft(source, size, hop)
    count = min(len(shifted), len(original))
    shifted, original = shifted[:count], original[:count]
    env_shifted = _envelope(np.abs(shifted), sr, size)
    env_original = _envelope(np.abs(original), sr, size)
    bins = np.arange(size // 2 + 1)
    warp = bins / (2.0 ** (formant_semitones / 12.0))  # target(f) = original(f / q)
    target = np.array([np.interp(warp, bins, row) for row in env_original])
    limit = np.log(10 ** (18 / 20))
    gain = np.exp(np.clip(target - env_shifted, -limit, limit))
    return _istft(shifted * gain, size, hop, length)


def saturate(x: np.ndarray, drive: float) -> np.ndarray:
    """Soft tanh saturation, level kept (peak-normalised in, same peak out)."""
    peak = float(np.max(np.abs(x))) or 1.0
    return peak * np.tanh(drive * x / peak) / np.tanh(drive)


def lowpass(x: np.ndarray, sr: int, cutoff_hz: float) -> np.ndarray:
    """Zero-phase low-pass with a 4th-order Butterworth magnitude, in one FFT."""
    return _filtered(x, sr, lambda f: 1.0 / np.sqrt(1.0 + (f / cutoff_hz) ** 8))


def comb(x: np.ndarray, sr: int, delay_ms: float, feedback: float) -> np.ndarray:
    """Feedback comb y[n] = x[n] + g·y[n−D] (a metallic resonance), in the frequency domain."""
    d = max(1, int(round(delay_ms * sr / 1000.0)))
    tail = int(d * np.log(1e-4) / np.log(min(max(feedback, 1e-3), 0.95)))
    size = 1 << int(np.ceil(np.log2(len(x) + tail + 1)))
    freqs = np.arange(size // 2 + 1) / size
    response = 1.0 / (1.0 - feedback * np.exp(-2j * np.pi * freqs * d))
    return np.fft.irfft(np.fft.rfft(x, size) * response, size)[: len(x)] * (1.0 - feedback)


def crush(x: np.ndarray, bits: int, hold: int) -> np.ndarray:
    """Sample-and-hold every `hold` samples, then quantised to `bits` (relative to the peak)."""
    peak = float(np.max(np.abs(x))) or 1.0
    held = np.repeat(x[::hold], hold)[: len(x)] if hold > 1 else x
    steps = 2 ** (bits - 1)
    return np.round(held / peak * steps) / steps * peak


def tone(x: np.ndarray, sr: int, points: tuple[tuple[float, float], ...]) -> np.ndarray:
    """Zero-phase EQ: a gain curve through (Hz, dB) points on a log-frequency axis."""
    hz = np.log([p[0] for p in points])
    db = np.array([p[1] for p in points])
    return _filtered(x, sr, lambda f: 10 ** (np.interp(np.log(np.maximum(f, 1.0)), hz, db) / 20))


def room(x: np.ndarray, sr: int, seconds: float, mix: float) -> np.ndarray:
    """A tight small-room tail: seeded decaying noise (the same every run), convolved and mixed in."""
    n = max(1, int(seconds * sr))
    rng = np.random.default_rng(1729)
    t = np.arange(n) / sr
    impulse = rng.standard_normal(n) * np.exp(-6.9 * t / seconds)  # −60 dB at `seconds`
    impulse[: int(0.004 * sr)] = 0.0  # starts after the direct sound
    impulse = lowpass(impulse, sr, 5000.0)
    impulse /= np.sqrt(np.sum(impulse**2)) or 1.0
    size = 1 << int(np.ceil(np.log2(len(x) + n)))
    wet = np.fft.irfft(np.fft.rfft(x, size) * np.fft.rfft(impulse, size), size)[: len(x) + n]
    return np.concatenate([x, np.zeros(n)]) + mix * wet


def _filtered(x: np.ndarray, sr: int, curve) -> np.ndarray:
    pad = int(0.05 * sr)
    n = len(x) + 2 * pad
    size = 1 << int(np.ceil(np.log2(n)))
    spectrum = np.fft.rfft(np.concatenate([np.zeros(pad), x, np.zeros(pad)]), size)
    freqs = np.fft.rfftfreq(size, 1.0 / sr)
    return np.fft.irfft(spectrum * curve(freqs), size)[pad : pad + len(x)]


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
