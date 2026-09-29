"""Setup and check helpers, used by scripts/speech-setup.* and by hand.

    python -m speech_gateway.tools prefetch
        Download Silero and the stress model now (instead of at first speech).
    python -m speech_gateway.tools voicestudio-install voxcpm2 [--url URL]
        Ask a running VoiceStudio (on loopback) to install one of its engines
        into its own sidecar venv, and wait until it is done.
    python -m speech_gateway.tools voicestudio-warm voxcpm2 [--url URL]
        Speak one phrase through a VoiceStudio engine, so its weights are
        downloaded now rather than on the first real line.
    python -m speech_gateway.tools voicestudio-model Systran/faster-whisper-large-v3 [--url URL]
        Download a model from VoiceStudio's catalogue (speech recognition
        answers 409 until a Whisper model is installed).
    python -m speech_gateway.tools smoke [--url URL] [--out DIR] [--wav FILE]
        End-to-end check of a running gateway: a Silero phrase, a VoiceStudio
        phrase, and a transcription; prints timings.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


def _json(method: str, url: str, body: dict | None = None, timeout: float = 30.0) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - local URLs
        return json.loads(response.read().decode() or "{}")


def prefetch() -> int:
    from .config import Settings
    from .silero_engine import SileroEngine

    settings = Settings.from_env()
    engine = SileroEngine(
        model=settings.silero_model,
        model_url=settings.silero_model_url,
        models_dir=settings.models_dir,
        device=settings.silero_device,
        threads=settings.silero_threads,
        lexicon_file=settings.lexicon_file,
    )
    started = time.perf_counter()
    engine.load()
    print(f"Silero {settings.silero_model} ready on {engine.device} in {time.perf_counter() - started:.1f}s "
          f"({engine.model_path})")
    return 0


def voicestudio_install(engine: str, url: str, timeout_s: float) -> int:
    base = url.rstrip("/")
    status = _json("GET", f"{base}/engines/sidecar/{engine}/install/status")
    if status.get("installed"):
        print(f"VoiceStudio engine {engine}: already installed.")
        return 0
    print(f"VoiceStudio engine {engine}: installing (this downloads several GB) …")
    _json("POST", f"{base}/engines/sidecar/{engine}/install", timeout=120)
    deadline = time.time() + timeout_s
    last = None
    while time.time() < deadline:
        time.sleep(10)
        status = _json("GET", f"{base}/engines/sidecar/{engine}/install/status")
        job = status.get("job") or {}
        steps = job.get("steps") or []
        running = next((s["id"] for s in steps if s.get("state") == "running"), None)
        if running != last:
            print(f"  step: {running or job.get('state')}")
            last = running
        if status.get("installed") and job.get("state") in (None, "done", "succeeded", "completed"):
            print(f"VoiceStudio engine {engine}: installed.")
            return 0
        if job.get("state") in ("failed", "error", "cancelled"):
            print(f"VoiceStudio engine {engine}: install failed.", file=sys.stderr)
            for line in (job.get("log") or [])[-15:]:
                print(f"  {line}", file=sys.stderr)
            return 1
    print(f"VoiceStudio engine {engine}: still installing after {timeout_s:.0f}s.", file=sys.stderr)
    return 1


def voicestudio_warm(model: str, url: str, timeout_s: float) -> int:
    """One short phrase through a VoiceStudio engine: downloads its weights now."""
    body = json.dumps({"model": model, "input": "Проверка связи.", "voice": "default",
                       "response_format": "wav", "language": "ru"}).encode()
    request = urllib.request.Request(f"{url.rstrip('/')}/v1/audio/speech", data=body, method="POST",
                                     headers={"Content-Type": "application/json"})
    print(f"VoiceStudio {model}: first phrase (downloads the weights on a fresh install) …")
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=timeout_s) as response:  # noqa: S310
            size = len(response.read())
    except urllib.error.HTTPError as exc:
        print(f"VoiceStudio {model}: HTTP {exc.code} {exc.read()[:300]!r}", file=sys.stderr)
        return 1
    print(f"VoiceStudio {model}: ready ({size} bytes in {time.perf_counter() - started:.0f}s).")
    return 0


def voicestudio_model(repo_id: str, url: str, timeout_s: float) -> int:
    """Download one model of VoiceStudio's catalogue (e.g. the Whisper weights)."""
    base = url.rstrip("/")

    def installed() -> bool:
        models = _json("GET", f"{base}/models", timeout=60).get("models", [])
        return any(m.get("repo_id") == repo_id and m.get("installed") for m in models)

    if installed():
        print(f"VoiceStudio model {repo_id}: already installed.")
        return 0
    print(f"VoiceStudio model {repo_id}: downloading …")
    _json("POST", f"{base}/models/install", {"repo_id": repo_id, "target": "local"}, timeout=120)
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        time.sleep(10)
        jobs = _json("GET", f"{base}/models/install/status").get("jobs", [])
        job = next((j for j in jobs if j.get("repo_id") == repo_id), None)
        if job and job.get("total_bytes"):
            print(f"  {job.get('bytes_done', 0) / 1e9:.2f} / {job['total_bytes'] / 1e9:.2f} GB")
        if job is None or job.get("state") not in ("downloading", "queued", "starting"):
            if installed():
                print(f"VoiceStudio model {repo_id}: installed.")
                return 0
            if job is None or job.get("state") in ("failed", "error", "cancelled"):
                print(f"VoiceStudio model {repo_id}: download failed ({job}).", file=sys.stderr)
                return 1
    print(f"VoiceStudio model {repo_id}: still downloading after {timeout_s:.0f}s.", file=sys.stderr)
    return 1


def smoke(url: str, out: Path, wav: Path | None) -> int:
    base = url.rstrip("/")
    out.mkdir(parents=True, exist_ok=True)
    ok = True
    health = _json("GET", f"{base}/health", timeout=10)
    print("health:", json.dumps(health, ensure_ascii=False))
    phrases = [
        ("silero:aidar", "Доброе утро. Система штаба на связи: сорок два агента готовы, замки открыты."),
        ("voicestudio:am7", "Брифинг начинается. Цель операции — проверка периметра."),
    ]
    for voice, text in phrases:
        body = json.dumps({"voice": voice, "input": text, "response_format": "wav"}).encode()
        request = urllib.request.Request(f"{base}/v1/audio/speech", data=body, method="POST",
                                         headers={"Content-Type": "application/json"})
        started = time.perf_counter()
        try:
            with urllib.request.urlopen(request, timeout=900) as response:  # noqa: S310
                audio = response.read()
                headers = {k.lower(): v for k, v in response.headers.items()}
        except urllib.error.HTTPError as exc:
            print(f"{voice}: HTTP {exc.code} {exc.read()[:300]!r}")
            ok = False
            continue
        elapsed = time.perf_counter() - started
        name = voice.replace(":", "_") + ".wav"
        (out / name).write_bytes(audio)
        print(f"{voice}: {len(audio)} bytes, {headers.get('x-speech-duration', '?')} s audio, "
              f"{elapsed:.2f} s, engine={headers.get('x-speech-engine')} "
              f"cache={headers.get('x-speech-cache')} fallback={headers.get('x-speech-fallback', '-')} -> {out / name}")
        if headers.get("x-speech-fallback"):
            ok = False
    sample = wav or out / "silero_aidar.wav"
    if sample.is_file():
        boundary = "----office3dspeech"
        payload = (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\nwhisper-1\r\n"
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"language\"\r\n\r\nru\r\n"
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{sample.name}\"\r\n"
            f"Content-Type: audio/wav\r\n\r\n"
        ).encode() + sample.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
        request = urllib.request.Request(f"{base}/v1/audio/transcriptions", data=payload, method="POST",
                                         headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
        started = time.perf_counter()
        try:
            with urllib.request.urlopen(request, timeout=900) as response:  # noqa: S310
                result = json.loads(response.read().decode())
            print(f"transcription ({sample.name}): {time.perf_counter() - started:.2f} s -> {result.get('text')!r}")
        except urllib.error.HTTPError as exc:
            print(f"transcription: HTTP {exc.code} {exc.read()[:300]!r}")
            ok = False
    return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except (AttributeError, ValueError):
            pass
    parser = argparse.ArgumentParser(prog="python -m speech_gateway.tools")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("prefetch")
    install = sub.add_parser("voicestudio-install")
    install.add_argument("engine")
    install.add_argument("--url", default="http://127.0.0.1:3900")
    install.add_argument("--timeout", type=float, default=3600)
    warm = sub.add_parser("voicestudio-warm")
    warm.add_argument("model")
    warm.add_argument("--url", default="http://127.0.0.1:3900")
    warm.add_argument("--timeout", type=float, default=3600)
    model = sub.add_parser("voicestudio-model")
    model.add_argument("repo_id")
    model.add_argument("--url", default="http://127.0.0.1:3900")
    model.add_argument("--timeout", type=float, default=3600)
    check = sub.add_parser("smoke")
    check.add_argument("--url", default="http://127.0.0.1:8765")
    check.add_argument("--out", type=Path, default=Path("speech-smoke"))
    check.add_argument("--wav", type=Path, default=None)
    args = parser.parse_args(argv)
    if args.command == "prefetch":
        return prefetch()
    if args.command == "voicestudio-install":
        return voicestudio_install(args.engine, args.url, args.timeout)
    if args.command == "voicestudio-warm":
        return voicestudio_warm(args.model, args.url, args.timeout)
    if args.command == "voicestudio-model":
        return voicestudio_model(args.repo_id, args.url, args.timeout)
    return smoke(args.url, args.out, args.wav)


if __name__ == "__main__":
    raise SystemExit(main())
