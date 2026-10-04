"""Setup and check helpers, used by scripts/speech-setup.* and by hand.

    python -m speech_gateway.tools prefetch
        Download Silero (the Russian and the CIS model), the stress model and
        the speech-recognition model (GigaAM v3 + Silero VAD) now, instead of
        at first use.
    python -m speech_gateway.tools prefetch-stt
        Only the speech-recognition model.
    python -m speech_gateway.tools smoke [--url URL] [--out DIR] [--wav FILE]
        End-to-end check of a running gateway: the system's and AM7's
        phrases, and a transcription; prints timings.
"""

from __future__ import annotations

import argparse
import json
import os
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


def prefetch_stt() -> int:
    """Download GigaAM and Silero VAD and run them once."""
    from .config import Settings
    from .stt_engine import GigaAMEngine

    settings = Settings.from_env()
    settings.use_hf_home()
    engine = GigaAMEngine(
        model=settings.stt_model,
        quantization=settings.stt_quantization,
        threads=settings.stt_threads,
        vad=settings.stt_vad,
        model_dir=settings.stt_model_dir,
    )
    started = time.perf_counter()
    engine.load()
    print(f"GigaAM {engine.describe()['model']} ready on cpu in {time.perf_counter() - started:.1f}s "
          f"({settings.stt_model_dir or 'HF_HOME=' + os.environ.get('HF_HOME', '')})")
    return 0


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
        lexicon_local_file=settings.lexicon_local,
        cis_model=settings.silero_cis_model,
    )
    started = time.perf_counter()
    engine.load()
    print(f"Silero {settings.silero_model} ready on {engine.device} in {time.perf_counter() - started:.1f}s "
          f"({engine.model_path})")
    engine.load_cis()
    print(f"Silero {settings.silero_cis_model} ready (AM7's and the crew's voices)")
    return prefetch_stt()


def smoke(url: str, out: Path, wav: Path | None) -> int:
    base = url.rstrip("/")
    out.mkdir(parents=True, exist_ok=True)
    ok = True
    health = _json("GET", f"{base}/health", timeout=10)
    print("health:", json.dumps(health, ensure_ascii=False))
    phrases = [
        ("silero:system", "Доброе утро. Система штаба на связи: сорок два агента готовы, все под контролем."),
        ("silero:am7", "Брифинг начинается. Цель операции — проверка периметра."),
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
              f"cache={headers.get('x-speech-cache')} -> {out / name}")
    sample = wav or out / "silero_system.wav"
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
        for attempt in ("first", "again"):
            started = time.perf_counter()
            try:
                with urllib.request.urlopen(request, timeout=900) as response:  # noqa: S310
                    result = json.loads(response.read().decode())
                    engine = response.headers.get("x-speech-stt-engine", "?")
                print(f"transcription ({sample.name}, {attempt}): {time.perf_counter() - started:.2f} s "
                      f"engine={engine} -> {result.get('text')!r}")
            except urllib.error.HTTPError as exc:
                print(f"transcription: HTTP {exc.code} {exc.read()[:300]!r}")
                ok = False
                break
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
    sub.add_parser("prefetch-stt")
    check = sub.add_parser("smoke")
    check.add_argument("--url", default="http://127.0.0.1:8765")
    check.add_argument("--out", type=Path, default=Path("speech-smoke"))
    check.add_argument("--wav", type=Path, default=None)
    args = parser.parse_args(argv)
    if args.command == "prefetch":
        return prefetch()
    if args.command == "prefetch-stt":
        return prefetch_stt()
    return smoke(args.url, args.out, args.wav)


if __name__ == "__main__":
    raise SystemExit(main())
