"""The HTTP surface: OpenAI-compatible speech, transcription and a voice list."""

from __future__ import annotations

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
from .audio import FORMATS, MEDIA_TYPES, Audio, concat, encode, resample
from .cache import SpeechCache, cache_key
from .config import Settings
from .text import chunk_text
from .voices import UnknownVoice, Voice, VoiceCatalog
from .voicestudio import VoiceStudioClient, VoiceStudioError

log = logging.getLogger("speech.gateway")


class SileroLike(Protocol):
    name: str
    model_id: str
    ready: bool

    def load(self) -> None: ...
    def describe(self) -> dict[str, Any]: ...
    def synthesize(self, text: str, speaker: str, speed: float = 1.0) -> Audio: ...


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


VOICESTUDIO_CHUNK_CHARS = 500

#: OpenAI's own model ids mean "whatever the voice's engine uses".
_PASSTHROUGH_MODELS = {"", "tts-1", "tts-1-hd", "gpt-4o-mini-tts", "silero", "voicestudio", "default"}


def create_app(
    settings: Settings | None = None,
    *,
    silero: SileroLike | None = None,
    voicestudio: VoiceStudioClient | None = None,
    catalog: VoiceCatalog | None = None,
    cache: SpeechCache | None = None,
    warmup: bool | None = None,
) -> FastAPI:
    settings = settings or Settings.from_env()
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
        )
    voicestudio = voicestudio or VoiceStudioClient(
        settings.voicestudio_url, api_key=settings.voicestudio_api_key, timeout_s=settings.voicestudio_timeout_s
    )
    catalog = catalog or VoiceCatalog.load(settings.voices_file, settings.default_voice, settings.voicestudio_model)
    cache = cache or SpeechCache(settings.cache_dir, settings.cache_max_mb * 1024 * 1024, settings.cache_enabled)
    do_warmup = settings.warmup if warmup is None else warmup

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        if do_warmup:
            def _warm() -> None:
                try:
                    silero.load()
                except Exception:  # reported by /health; the next request retries
                    pass

            threading.Thread(target=_warm, name="silero-warmup", daemon=True).start()
        yield

    app = FastAPI(title="Office3D speech gateway", version=__version__, lifespan=lifespan)
    app.state.settings = settings
    app.state.catalog = catalog
    state = {"voicestudio_down_until": 0.0}

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
        vs = await voicestudio.health()
        silero_state = silero.describe()
        return {
            "status": "ok" if silero_state.get("ready") or vs.get("reachable") else "degraded",
            "version": __version__,
            "engines": {"silero": silero_state, "voicestudio": vs},
            "default_voice": catalog.default_voice,
        }

    @app.get("/v1/voices")
    async def voices() -> dict[str, Any]:
        return {
            "object": "list",
            "default": catalog.default_voice,
            "data": [voice.public() for voice in catalog.list()],
        }

    async def _render(voice: Voice, text: str, speed: float, model: str | None) -> Audio:
        if voice.engine == "silero":
            return await run_in_threadpool(silero.synthesize, text, voice.params["speaker"], speed)
        params = dict(voice.params)
        if model and model not in _PASSTHROUGH_MODELS:
            params["model"] = model
        params.setdefault("model", catalog.voicestudio_model)
        # VoiceStudio takes at most 4096 characters, and designed voices stay
        # steadier over short spans: long text goes sentence by sentence.
        chunks = chunk_text(text, limit=VOICESTUDIO_CHUNK_CHARS) or [text]
        if len(chunks) == 1:
            return await voicestudio.synthesize(text, params, speed)
        parts = [await voicestudio.synthesize(chunk, params, speed) for chunk in chunks]
        rate = parts[0].sample_rate
        return Audio(concat([resample(p.samples, p.sample_rate, rate) for p in parts], rate), rate)

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
        served = voice
        fallback_used = False
        identity = {"voice": voice.cache_identity(), "text": text, "speed": round(req.speed, 3),
                    "format": req.response_format, "model": req.model or "", "silero": silero.model_id}
        key = cache_key(identity)
        cached = cache.get(key, req.response_format)
        if cached is not None:
            return Response(
                content=cached,
                media_type=MEDIA_TYPES[req.response_format],
                headers={"X-Speech-Voice": voice.id, "X-Speech-Engine": voice.engine, "X-Speech-Cache": "hit"},
            )
        async def _fallback(reason: str) -> Audio:
            nonlocal served, fallback_used
            log.warning("%s unavailable (%s); speaking with %s", voice.id, reason, voice.fallback)
            served = catalog.resolve(voice.fallback)
            audio = await _render(served, text, req.speed, None)
            fallback_used = True
            return audio

        try:
            if voice.engine == "voicestudio" and voice.fallback and time.monotonic() < state["voicestudio_down_until"]:
                # VoiceStudio just failed to answer: don't make every line wait
                # for the same timeout again; its fallback speaks at once.
                audio = await _fallback("backing off after a recent failure")
            else:
                audio = await _render(voice, text, req.speed, req.model)
        except VoiceStudioError as exc:
            if exc.unreachable:
                state["voicestudio_down_until"] = time.monotonic() + settings.voicestudio_backoff_s
            if exc.unreachable and voice.fallback:
                try:
                    audio = await _fallback(exc.message)
                except Exception:
                    log.exception("fallback voice failed")
                    return openai_error(503, "Speech engines are unavailable.", code="engine_unavailable")
            else:
                return openai_error(exc.status, exc.message, code="voicestudio_error")
        except ValueError as exc:
            return openai_error(400, str(exc), param="input", code="invalid_value")
        except Exception:
            log.exception("synthesis failed for %s", voice.id)
            return openai_error(503, f"The {voice.engine} engine could not speak right now.", code="engine_unavailable")

        data = await run_in_threadpool(encode, audio, req.response_format)
        if not fallback_used:
            cache.put(key, req.response_format, data)
        elapsed = time.perf_counter() - started
        log.info("spoke %d chars as %s in %.2fs (%.1fs audio)", len(text), served.id, elapsed, audio.duration_s)
        headers = {
            "X-Speech-Voice": served.id,
            "X-Speech-Engine": served.engine,
            "X-Speech-Cache": "miss",
            "X-Speech-Duration": f"{audio.duration_s:.3f}",
        }
        if fallback_used:
            headers["X-Speech-Fallback"] = served.id
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
        limit = settings.max_upload_mb * 1024 * 1024
        data = await file.read(limit + 1)
        if not data:
            return openai_error(400, "file is empty.", param="file", code="invalid_value")
        if len(data) > limit:
            return openai_error(413, f"file is larger than {settings.max_upload_mb} MB.", param="file", code="file_too_large")
        if response_format and response_format not in {"json", "text", "verbose_json", "srt", "vtt"}:
            return openai_error(400, "response_format must be json, text, verbose_json, srt or vtt.", param="response_format", code="invalid_value")
        fields: dict[str, str] = {"model": model or "whisper-1"}
        lang = (language or settings.stt_language or "").strip()
        if lang:
            fields["language"] = lang
        if prompt:
            fields["prompt"] = prompt
        if response_format:
            fields["response_format"] = response_format
        if temperature is not None:
            fields["temperature"] = str(temperature)
        started = time.perf_counter()
        try:
            upstream = await voicestudio.transcribe(
                file=data,
                filename=file.filename or "audio.webm",
                content_type=file.content_type or "application/octet-stream",
                fields=fields,
            )
        except VoiceStudioError as exc:
            return openai_error(exc.status, exc.message, code="voicestudio_error")
        log.info("transcribed %d bytes in %.2fs", len(data), time.perf_counter() - started)
        return Response(
            content=upstream.content,
            status_code=200,
            media_type=upstream.headers.get("content-type", "application/json"),
        )

    return app


__all__ = ["create_app", "SpeechRequest", "FORMATS"]
