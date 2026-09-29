"""A small on-disk cache of encoded speech, keyed by a hash of the request.

The same line in the same voice (a greeting, a briefing opener) is rendered
once. Oldest files are dropped when the cache grows past its size limit.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from pathlib import Path
from typing import Any


def cache_key(payload: dict[str, Any]) -> str:
    blob = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


class SpeechCache:
    def __init__(self, directory: Path, max_bytes: int, enabled: bool = True) -> None:
        self.directory = directory
        self.max_bytes = max_bytes
        self.enabled = enabled and max_bytes > 0
        self._lock = threading.Lock()

    def _path(self, key: str, fmt: str) -> Path:
        return self.directory / key[:2] / f"{key}.{fmt}"

    def get(self, key: str, fmt: str) -> bytes | None:
        if not self.enabled:
            return None
        path = self._path(key, fmt)
        try:
            data = path.read_bytes()
        except OSError:
            return None
        try:
            os.utime(path, None)
        except OSError:
            pass
        return data

    def put(self, key: str, fmt: str, data: bytes) -> None:
        if not self.enabled or len(data) > self.max_bytes:
            return
        path = self._path(key, fmt)
        with self._lock:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(f".{fmt}.{os.getpid()}.{time.time_ns()}.tmp")
            tmp.write_bytes(data)
            tmp.replace(path)
            self._prune()

    def _prune(self) -> None:
        files = [p for p in self.directory.rglob("*") if p.is_file() and not p.name.endswith(".tmp")]
        total = sum(p.stat().st_size for p in files)
        if total <= self.max_bytes:
            return
        for path in sorted(files, key=lambda p: p.stat().st_mtime):
            try:
                size = path.stat().st_size
                path.unlink()
                total -= size
            except OSError:
                continue
            if total <= self.max_bytes * 0.9:
                break
