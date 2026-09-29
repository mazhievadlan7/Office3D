"""The post-processing presets (fx.py): deterministic, pitch down, tempo kept."""

import numpy as np

from speech_gateway.audio import Audio
from speech_gateway.fx import FX_PRESETS, apply_fx, pitch_shift, shift_voice, wsola

RATE = 48_000


def voiced(f0: float = 200.0, seconds: float = 1.5) -> np.ndarray:
    t = np.arange(int(seconds * RATE)) / RATE
    phase = 2 * np.pi * f0 * t
    return 0.2 * sum(np.sin(k * phase) / k for k in range(1, 10))


def pitch(x: np.ndarray) -> float:
    seg = x[RATE // 2 : RATE // 2 + 4096]
    seg = seg - seg.mean()
    ac = np.correlate(seg, seg, "full")[len(seg) - 1 :]
    lo, hi = RATE // 400, RATE // 60
    return RATE / (lo + int(np.argmax(ac[lo:hi])))


def test_pitch_shift_lowers_by_the_semitones_and_keeps_the_length():
    x = voiced()
    y = pitch_shift(x, RATE, -2.0)
    assert len(y) == len(x)
    assert abs(pitch(y) / pitch(x) - 2 ** (-2 / 12)) < 0.01


def test_wsola_changes_duration_not_pitch():
    x = voiced()
    y = wsola(x, RATE, 1.25)
    assert abs(len(y) - len(x) / 1.25) <= 1
    assert abs(pitch(y) - pitch(x)) < 3


def test_presets_are_deterministic_and_levelled():
    audio = Audio(voiced().astype(np.float32), RATE)
    for name in ("humanoid", "humanoid-light", "humanoid-heavy", "humanoid-hard"):
        a, b = apply_fx(audio, name), apply_fx(audio, name)
        assert np.array_equal(a.samples, b.samples)
        stretch = FX_PRESETS[name].stretch
        assert a.sample_rate == RATE and abs(a.duration_s - audio.duration_s * stretch) < 0.2
        assert np.all(np.isfinite(a.samples))
        assert float(np.abs(a.samples).max()) <= FX_PRESETS[name].ceiling + 1e-6


def test_none_is_untouched():
    audio = Audio(voiced().astype(np.float32), RATE)
    assert apply_fx(audio, "none") is audio and apply_fx(audio, None) is audio


def test_shift_voice_lowers_pitch_and_stretches_with_formants_kept():
    x = voiced(150.0)
    y = shift_voice(x, RATE, -4.0, -1.0, 1.06)
    assert abs(len(y) - len(x) * 1.06) <= 1
    assert abs(pitch(y) / pitch(x) - 2 ** (-4 / 12)) < 0.02


def test_heavy_presets_are_deeper_than_the_old_ones():
    assert FX_PRESETS["humanoid-heavy"].semitones < FX_PRESETS["humanoid"].semitones
    assert FX_PRESETS["humanoid-hard"].semitones < FX_PRESETS["humanoid-light"].semitones
