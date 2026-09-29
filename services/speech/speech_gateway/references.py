"""Reference clips of the designed voices (voice-refs/*.flac).

Each is a few seconds of a VoxCPM2-designed voice (synthetic: no real
person's recording) saying a known line. VoiceStudio clones it for every line
of that voice, which keeps the timbre identical from line to line, where
designing the voice again from its description drifts. Clips are looked up in
the speech home first (a server's own takes), then in the repository.
"""

from __future__ import annotations

import hashlib
import io
import logging
import threading
from dataclasses import dataclass
from pathlib import Path

import soundfile as sf

log = logging.getLogger("speech.references")


@dataclass(frozen=True)
class ReferenceClip:
    path: Path
    #: sha256 of the file: names the VoiceStudio profile and keys the cache.
    sha256: str
    #: The clip as 16-bit PCM WAV (what VoiceStudio is given).
    wav: bytes


class ReferenceStore:
    def __init__(self, directories: tuple[Path, ...]) -> None:
        self.directories = directories
        self._clips: dict[str, tuple[float, ReferenceClip]] = {}
        self._missing_logged: set[str] = set()
        self._lock = threading.Lock()

    def find(self, file: str) -> Path | None:
        if Path(file).name != file:
            return None
        for directory in self.directories:
            path = directory / file
            if path.is_file():
                return path
        return None

    def get(self, file: str) -> ReferenceClip | None:
        """The clip, or None when no directory has it (the voice is then designed from its description)."""
        path = self.find(file)
        if path is None:
            if file not in self._missing_logged:
                self._missing_logged.add(file)
                log.warning("voice reference %s not found in %s", file, ", ".join(str(d) for d in self.directories))
            return None
        mtime = path.stat().st_mtime
        with self._lock:
            cached = self._clips.get(file)
            if cached and cached[0] == mtime and cached[1].path == path:
                return cached[1]
            data = path.read_bytes()
            samples, rate = sf.read(io.BytesIO(data), dtype="float32", always_2d=False)
            if getattr(samples, "ndim", 1) == 2:
                samples = samples.mean(axis=1)
            buffer = io.BytesIO()
            sf.write(buffer, samples, rate, format="WAV", subtype="PCM_16")
            clip = ReferenceClip(path=path, sha256=hashlib.sha256(data).hexdigest(), wav=buffer.getvalue())
            self._clips[file] = (mtime, clip)
            return clip

    def sha(self, file: str) -> str | None:
        clip = self.get(file)
        return clip.sha256 if clip else None
