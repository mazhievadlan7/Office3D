"""The HTTP surface: OpenAI-compatible speech, transcription and a voice list."""

from __future__ import annotations

import json
import logging
import threading
import time
from contextlib import asynccontextmanager
from typing import Any, Literal, Optional, Protocol

from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field, field_validator
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import __version__
from .audio import FORMATS, MEDIA_TYPES, Audio, UndecodableAudio, encode
from .cache import SpeechCache, cache_key
from .config import Settings
from .fx import FX_VERSION, apply_fx
from .stt_engine import Transcript
from .text import StressLexicon, load_stress
from .voices import UnknownVoice, Voice, VoiceCatalog

log = logging.getLogger("speech.gateway")


class SileroLike(Protocol):
    name: str
    model_id: str
    ready: bool

    def load(self) -> None: ...
    def describe(self) -> dict[str, Any]: ...
    def synthesize(self, text: str, speaker: str, speed: float = 1.0) -> Audio: ...


class SttLike(Protocol):
    name: str
    ready: bool

    def load(self) -> None: ...
    def describe(self) -> dict[str, Any]: ...
    def transcribe(self, data: bytes) -> Transcript: ...


def _timestamp(seconds: float, sep: str) -> str:
    ms = int(round(seconds * 1000))
    hours, ms = divmod(ms, 3_600_000)
    minutes, ms = divmod(ms, 60_000)
    secs, ms = divmod(ms, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}{sep}{ms:03d}"


def transcript_response(transcript: Transcript, response_format: str | None, headers: dict[str, str]) -> Response:
    """The shapes OpenAI's /audio/transcriptions answers with."""
    fmt = response_format or "json"
    if fmt == "text":
        return Response(content=transcript.text, media_type="text/plain; charset=utf-8", headers=headers)
    if fmt in ("srt", "vtt"):
        sep = "," if fmt == "srt" else "."
        blocks = []
        for index, seg in enumerate(transcript.segments, start=1):
            stamp = f"{_timestamp(seg.start, sep)} --> {_timestamp(seg.end, sep)}"
            blocks.append(f"{index}\n{stamp}\n{seg.text}\n" if fmt == "srt" else f"{stamp}\n{seg.text}\n")
        body = "\n".join(blocks)
        if fmt == "vtt":
            body = "WEBVTT\n\n" + body
        return Response(content=body, media_type="text/plain; charset=utf-8", headers=headers)
    payload: dict[str, Any] = {"text": transcript.text}
    if fmt == "verbose_json":
        payload = {
            "task": "transcribe",
            "language": "russian",
            "duration": round(transcript.duration_s, 3),
            "text": transcript.text,
            "segments": [
                {"id": i, "start": s.start, "end": s.end, "text": s.text} for i, s in enumerate(transcript.segments)
            ],
        }
    return Response(content=json.dumps(payload, ensure_ascii=False), media_type="application/json", headers=headers)


class SpeechRequest(BaseModel):
    """POST /v1/audio/speech — OpenAI's CreateSpeechRequest, minus what we cannot honour."""

    model: Optional[str] = None
    input: str = Field(..., min_length=1)
    voice: Optional[str] = None
    response_format: Literal["mp3", "wav", "opus", "flac", "pcm"] = "mp3"
    speed: float = Field(default=1.0, ge=0.25, le=4.0)

    @field_validator("voice", mode="before")
    @classmethod
    def _voice_object(cls, value: Any) -> Any:
        if isinstance(value, dict):  # OpenAI's {"id": "..."} form
            return value.get("id")
        return value


def openai_error(status: int, message: str, *, code: str | None = None, param: str | None = None) -> JSONResponse:
    kind = "invalid_request_error" if status < 500 else "server_error"
    return JSONResponse(
        status_code=status,
        content={"error": {"message": message, "type": kind, "param": param, "code": code}},
    )


def create_app(
    settings: Settings | None = None,
    *,
    silero: SileroLike | None = None,
    catalog: VoiceCatalog | None = None,
    cache: SpeechCache | None = None,
    stt: SttLike | None = None,
    warmup: bool | None = None,
    stress: StressLexicon | None = None,
) -> FastAPI:
    settings = settings or Settings.from_env()
    if stt is None:
        from .stt_engine import GigaAMEngine

        try:
            stt = GigaAMEngine(
                model=settings.stt_model,
                quantization=settings.stt_quantization,
                threads=settings.stt_threads,
                vad=settings.stt_vad,
                model_dir=settings.stt_model_dir,
            )
        except ValueError:
            log.exception("speech recognition: bad SPEECH_STT_MODEL; recognition is off")
            stt = None
    if silero is None:
        from .silero_engine import SileroEngine

        silero = SileroEngine(
            model=settings.silero_model,
            model_url=settings.silero_model_url,
            models_dir=settings.models_dir,
            device=settings.silero_device,
            threads=settings.silero_threads,
            sample_rate=settings.silero_sample_rate,
            lexicon_file=settings.lexicon_file,
            lexicon_local_file=settings.lexicon_local,
            cis_model=settings.silero_cis_model,
        )
    catalog = catalog or VoiceCatalog.load(settings.voices_file, settings.default_voice)
    cache = cache or SpeechCache(settings.cache_dir, settings.cache_max_mb * 1024 * 1024, settings.cache_enabled)
    stress = stress if stress is not None else load_stress(settings.stress_file, settings.stress_local)
    do_warmup = settings.warmup if warmup is None else warmup

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        if do_warmup:
            def _load(engine: Any) -> None:
                try:
                    engine.load()
                except Exception:  # reported by /health; the next request retries
                    pass

            # Recognition first: it loads in seconds, Silero's torch takes longer.
            if stt is not None:
                threading.Thread(target=_load, args=(stt,), name="stt-warmup", daemon=True).start()
            threading.Thread(target=_load, args=(silero,), name="silero-warmup", daemon=True).start()
        yield

    app = FastAPI(title="Office3D speech gateway", version=__version__, lifespan=lifespan)
    app.state.settings = settings
    app.state.catalog = catalog

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_request: Request, exc: StarletteHTTPException) -> JSONResponse:
        message = exc.detail if isinstance(exc.detail, str) else "Request failed."
        return openai_error(exc.status_code, message, code="http_error")

    @app.exception_handler(RequestValidationError)
    async def _validation(_request: Request, exc: RequestValidationError) -> JSONResponse:
        first = exc.errors()[0] if exc.errors() else {}
        loc = [str(part) for part in first.get("loc", []) if part not in ("body", "form")]
        param = ".".join(loc) or None
        return openai_error(400, f"Invalid request: {param or 'body'}: {first.get('msg', 'invalid')}", param=param, code="invalid_value")

    @app.get("/health")
    async def health() -> dict[str, Any]:
        silero_state = silero.describe()
        stt_state = stt.describe() if stt is not None else {"engine": "gigaam", "ready": False, "error": "not configured"}
        return {
            "status": "ok" if silero_state.get("ready") else "degraded",
            "version": __version__,
            "engines": {"silero": silero_state, "stt": stt_state},
            "default_voice": catalog.default_voice,
        }

    @app.get("/v1/voices")
    async def voices() -> dict[str, Any]:
        return {
            "object": "list",
            "default": catalog.default_voice,
            "data": [voice.public() for voice in catalog.list()],
        }

    def _silero_model(voice: Voice) -> str:
        model_for = getattr(silero, "model_for", None)
        speaker = voice.params.get("speaker", "")
        return model_for(speaker) if callable(model_for) and speaker else silero.model_id

    async def _render(voice: Voice, text: str, speed: float) -> Audio:
        marked = stress.apply(text, marks=True)
        return await run_in_threadpool(silero.synthesize, marked, voice.params["speaker"], speed)

    @app.post("/v1/audio/speech")
    async def speech(req: SpeechRequest) -> Response:
        text = " ".join(req.input.split())
        if not text:
            return openai_error(400, "input is empty.", param="input", code="invalid_value")
        if len(text) > settings.max_input_chars:
            return openai_error(400, f"input is longer than {settings.max_input_chars} characters.", param="input", code="input_too_long")
        try:
            voice = catalog.resolve(req.voice)
        except UnknownVoice as exc:
            return openai_error(400, str(exc), param="voice", code="voice_not_found")

        started = time.perf_counter()
        identity: dict[str, Any] = {"voice": voice.cache_identity(), "text": text, "speed": round(req.speed, 3),
                                    "format": req.response_format, "model": req.model or "", "silero": _silero_model(voice)}
        text_version = getattr(silero, "text_version", "")
        if text_version:
            identity["text"] = [text, text_version]
        if voice.fx != "none":
            identity["fx"] = [voice.fx, FX_VERSION]
        if stress.version:
            identity["stress"] = stress.version
        key = cache_key(identity)
        cached = cache.get(key, req.response_format)
        if cached is not None:
            return Response(
                content=cached,
                media_type=MEDIA_TYPES[req.response_format],
                headers={"X-Speech-Voice": voice.id, "X-Speech-Engine": voice.engine, "X-Speech-Cache": "hit"},
            )
        try:
            audio = await _render(voice, text, req.speed)
        except ValueError as exc:
            return openai_error(400, str(exc), param="input", code="invalid_value")
        except Exception:
            log.exception("synthesis failed for %s", voice.id)
            return openai_error(503, f"The {voice.engine} engine could not speak right now.", code="engine_unavailable")

        # The voice's own treatment: the preset is what is heard.
        if voice.fx != "none":
            audio = await run_in_threadpool(apply_fx, audio, voice.fx)
        data = await run_in_threadpool(encode, audio, req.response_format)
        cache.put(key, req.response_format, data)
        elapsed = time.perf_counter() - started
        log.info("spoke %d chars as %s in %.2fs (%.1fs audio)", len(text), voice.id, elapsed, audio.duration_s)
        headers = {
            "X-Speech-Voice": voice.id,
            "X-Speech-Engine": voice.engine,
            "X-Speech-Cache": "miss",
            "X-Speech-Duration": f"{audio.duration_s:.3f}",
            "X-Speech-FX": voice.fx,
        }
        return Response(content=data, media_type=MEDIA_TYPES[req.response_format], headers=headers)

    @app.post("/v1/audio/transcriptions")
    async def transcriptions(
        file: UploadFile = File(...),
        model: Optional[str] = Form(default=None),
        language: Optional[str] = Form(default=None),
        prompt: Optional[str] = Form(default=None),
        response_format: Optional[str] = Form(default=None),
        temperature: Optional[float] = Form(default=None),
    ) -> Response:
        # GigaAM recognises Russian; `model`, `language`, `prompt` and
        # `temperature` are accepted for OpenAI compatibility and not used.
        limit = settings.max_upload_mb * 1024 * 1024
        data = await file.read(limit + 1)
        if not data:
            return openai_error(400, "file is empty.", param="file", code="invalid_value")
        if len(data) > limit:
            return openai_error(413, f"file is larger than {settings.max_upload_mb} MB.", param="file", code="file_too_large")
        if response_format and response_format not in {"json", "text", "verbose_json", "srt", "vtt"}:
            return openai_error(400, "response_format must be json, text, verbose_json, srt or vtt.", param="response_format", code="invalid_value")
        if stt is None:
            return openai_error(503, "Speech recognition (GigaAM) is not configured.", code="engine_unavailable")
        started = time.perf_counter()
        try:
            transcript = await run_in_threadpool(stt.transcribe, data)
        except UndecodableAudio as exc:
            return openai_error(400, f"file: {exc}", param="file", code="invalid_value")
        except Exception:
            log.exception("recognition failed")
            return openai_error(503, "Speech recognition (GigaAM) could not run right now.", code="engine_unavailable")
        elapsed = time.perf_counter() - started
        log.info("transcribed %.1fs of audio (%d bytes) with %s in %.2fs", transcript.duration_s, len(data), stt.name, elapsed)
        headers = {"X-Speech-STT-Engine": stt.name, "X-Speech-Duration": f"{transcript.duration_s:.3f}"}
        return transcript_response(transcript, response_format, headers)

    return app


__all__ = ["create_app", "SpeechRequest", "FORMATS"]
