import sys
from pathlib import Path

import numpy as np
import pytest

SERVICE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_DIR))

from speech_gateway.audio import Audio  # noqa: E402


class FakeSilero:
    """Stands in for Silero: no torch, no model — a tone as long as the text."""

    name = "silero"
    model_id = "fake_v5"

    def __init__(self, fail: bool = False) -> None:
        self.ready = True
        self.fail = fail
        self.calls: list[tuple[str, str, float]] = []

    def load(self) -> None:
        pass

    def describe(self) -> dict:
        return {"ready": self.ready, "model": self.model_id, "device": "cpu"}

    def synthesize(self, text: str, speaker: str, speed: float = 1.0) -> Audio:
        self.calls.append((text, speaker, speed))
        if self.fail:
            raise RuntimeError("model exploded")
        rate = 48_000
        n = rate // 10
        t = np.arange(n) / rate
        return Audio((0.2 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), rate)


@pytest.fixture
def fake_silero():
    return FakeSilero()
