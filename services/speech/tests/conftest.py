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


class FakeStt:
    """Stands in for GigaAM: no onnxruntime, no model — a fixed transcript."""

    name = "gigaam"

    def __init__(self, text: str = "Покажи статус операции.", fail: Exception | None = None) -> None:
        self.ready = True
        self.text = text
        self.fail = fail
        self.loads = 0
        self.calls: list[bytes] = []

    def load(self) -> None:
        self.loads += 1

    def describe(self) -> dict:
        return {"engine": self.name, "ready": self.ready, "model": "fake-gigaam", "device": "cpu"}

    def transcribe(self, data: bytes):
        from speech_gateway.stt_engine import Segment, Transcript

        self.calls.append(data)
        if self.fail is not None:
            raise self.fail
        return Transcript(self.text, 3.2, [Segment(0.4, 2.9, self.text)])


@pytest.fixture
def fake_silero():
    return FakeSilero()
