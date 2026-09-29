"""The HTTP surface: OpenAI-compatible speech, transcription and a voice list."""

from __future__ import annotations

import asyncio
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
from .audio import FORMATS, MEDIA_TYPES, Audio, UndecodableAudio, concat, encode, resample
from .cache import SpeechCache, cache_key
from .config import Settings
from .fx import FX_VERSION, apply_fx
from .references import ReferenceStore
from .stt_engine import Transcript
from .text import StressLexicon, chunk_text, load_stress
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


class SttLike(Protocol):
    name: str
    ready: bool

    def load(self) -> None: ...
    def describe(self) -> dict[str, Any]: ...
    def transcribe(self, data: bytes) -> Transcript: ...


#: Transcription `model` values that ask for VoiceStudio's Whisper explicitly.
#: Anything else (OpenAI's "whisper-1" included) means the configured engine.
def _wants_voicestudio(model: str | None) -> bool:
    return (model or "").strip().lower().startswith("voicestudio")


_RUSSIAN = {"", "ru", "rus", "russian", "ru-ru"}
_WARMUP_PHRASE = "Связь установлена."


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
    stt: SttLike | None = None,
    warmup: bool | None = None,
    references: ReferenceStore | None = None,
    stress: StressLexicon | None = None,
) -> FastAPI:
    settings = settings or Settings.from_env()
    if stt is None and settings.stt_engine == "gigaam":
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
            log.exception("speech recognition: bad SPEECH_STT_MODEL; using VoiceStudio")
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
            cis_model=settings.silero_cis_model,
        )
    voicestudio = voicestudio or VoiceStudioClient(
        settings.voicestudio_url, api_key=settings.voicestudio_api_key, timeout_s=settings.voicestudio_timeout_s
    )
    catalog = catalog or VoiceCatalog.load(settings.voices_file, settings.default_voice, settings.voicestudio_model)
    cache = cache or SpeechCache(settings.cache_dir, settings.cache_max_mb * 1024 * 1024, settings.cache_enabled)
    references = references or ReferenceStore(settings.voice_refs_dirs)
    stress = stress if stress is not None else load_stress(settings.stress_file)
    do_warmup = settings.warmup if warmup is None else warmup
    state: dict[str, Any] = {"voicestudio_down_until": 0.0}
    warm_state: dict[str, Any] = {"state": "off"}

    async def warm_voicestudio() -> None:
        """Loads the lead voice's engine (VoxCPM2) on the GPU once at start-up.

        VoiceStudio may still be starting next to us: wait for it first. With
        VoiceStudio's idle reaping off (OMNIVOICE_SIDECAR_IDLE_TIMEOUT_S=0, set
        by `npm run speech`) the model then stays loaded.
        """
        voice = next((v for v in catalog.list() if v.engine == "voicestudio" and v.role == "lead"), None)
        voice = voice or next((v for v in catalog.list() if v.engine == "voicestudio"), None)
        if voice is None:
            return
        deadline = time.monotonic() + settings.voicestudio_warmup_timeout_s
        warm_state.update(state="waiting", voice=voice.id)
        while not (await voicestudio.health()).get("reachable"):
            if time.monotonic() >= deadline:
                warm_state.update(state="skipped", reason="VoiceStudio did not answer")
                return
            await asyncio.sleep(3.0)
        warm_state["state"] = "loading"
        started = time.perf_counter()
        try:
            params = await _voicestudio_params(voice, None)
            await voicestudio.synthesize(
                _WARMUP_PHRASE, params, 1.0, timeout_s=max(10.0, deadline - time.monotonic())
            )
        except VoiceStudioError as exc:
            warm_state.update(state="failed", reason=exc.message)
            log.warning("VoiceStudio warm-up failed: %s", exc.message)
            return
        seconds = round(time.perf_counter() - started, 1)
        warm_state.update(state="ready", seconds=seconds)
        state["voicestudio_down_until"] = 0.0
        log.info("VoiceStudio %s warm (%s on the GPU) in %.1fs", voice.id, params["model"], seconds)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        task: asyncio.Task | None = None
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
            if settings.voicestudio_warmup:
                task = asyncio.create_task(warm_voicestudio())
        yield
        if task is not None and not task.done():
            task.cancel()

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
        vs = await voicestudio.health()
        vs["warmup"] = dict(warm_state)
        silero_state = silero.describe()
        stt_state = stt.describe() if stt is not None else {"engine": "voicestudio", "ready": bool(vs.get("reachable"))}
        stt_state["fallback"] = "voicestudio" if settings.stt_fallback and stt is not None else None
        return {
            "status": "ok" if silero_state.get("ready") or vs.get("reachable") else "degraded",
            "version": __version__,
            "engines": {"silero": silero_state, "voicestudio": vs, "stt": stt_state},
            "default_voice": catalog.default_voice,
        }

    @app.get("/v1/voices")
    async def voices() -> dict[str, Any]:
        return {
            "object": "list",
            "default": catalog.default_voice,
            "data": [voice.public() for voice in catalog.list()],
        }

    async def _voicestudio_params(voice: Voice, model: str | None) -> dict[str, Any]:
        """What VoiceStudio is asked for: the preset, with its reference clip's profile when it has one."""
        params = dict(voice.params)
        if model and model not in _PASSTHROUGH_MODELS:
            params["model"] = model
        params.setdefault("model", catalog.voicestudio_model)
        if voice.reference is not None:
            clip = await run_in_threadpool(references.get, voice.reference.file)
            if clip is not None:
                try:
                    params["voice"] = await voicestudio.ensure_profile(
                        f"office3d-{voice.name}-{clip.sha256[:12]}",
                        wav=clip.wav,
                        text=voice.reference.text,
                        seed=params.get("seed"),
                        language=params.get("language"),
                    )
                    # The clip is the voice now: a description would switch VoxCPM2 out of cloning.
                    params.pop("description", None)
                    params.pop("instruct", None)
                except VoiceStudioError as exc:
                    if exc.unreachable:
                        raise
                    log.warning("%s: no voice profile (%s); designing the voice from its description", voice.id, exc.message)
        return params

    def _silero_model(voice: Voice) -> str:
        model_for = getattr(silero, "model_for", None)
        speaker = voice.params.get("speaker", "")
        return model_for(speaker) if callable(model_for) and speaker else silero.model_id

    async def _render(voice: Voice, text: str, speed: float, model: str | None) -> Audio:
        if voice.engine == "silero":
            marked = stress.apply(text, marks=True)
            return await run_in_threadpool(silero.synthesize, marked, voice.params["speaker"], speed)
        text = stress.apply(text, marks=False)
        params = await _voicestudio_params(voice, model)
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
        identity: dict[str, Any] = {"voice": voice.cache_identity(), "text": text, "speed": round(req.speed, 3),
                                    "format": req.response_format, "model": req.model or "", "silero": silero.model_id}
        if voice.engine == "silero":
            identity["silero"] = _silero_model(voice)
        if voice.fx != "none":
            identity["fx"] = [voice.fx, FX_VERSION]
        if stress.version:
            identity["stress"] = stress.version
        if voice.reference is not None:
            identity["reference"] = await run_in_threadpool(references.sha, voice.reference.file)
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

        # The voice's own treatment, on the fallback too: the preset is what is heard.
        if voice.fx != "none":
            audio = await run_in_threadpool(apply_fx, audio, voice.fx)
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
            "X-Speech-FX": voice.fx,
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
        lang = (language or settings.stt_language or "").strip()
        started = time.perf_counter()
        # GigaAM knows Russian only: another language goes to VoiceStudio's Whisper.
        local = stt is not None and not _wants_voicestudio(model) and (
            lang.lower() in _RUSSIAN or not settings.stt_fallback
        )
        if local and settings.stt_fallback and getattr(stt, "loading", False) and not stt.ready:
            # First start: GigaAM is still downloading; don't hold the command.
            log.info("recognition: GigaAM still loading; asking VoiceStudio")
            local = False
        if local:
            assert stt is not None
            try:
                transcript = await run_in_threadpool(stt.transcribe, data)
            except UndecodableAudio as exc:
                if not settings.stt_fallback:
                    return openai_error(400, f"file: {exc}", param="file", code="invalid_value")
                log.warning("recognition: %s; asking VoiceStudio", exc)
            except Exception:
                log.exception("recognition failed")
                if not settings.stt_fallback:
                    return openai_error(503, "Speech recognition could not run right now.", code="engine_unavailable")
                log.warning("recognition: GigaAM unavailable; asking VoiceStudio")
            else:
                elapsed = time.perf_counter() - started
                log.info("transcribed %.1fs of audio (%d bytes) with %s in %.2fs", transcript.duration_s, len(data), stt.name, elapsed)
                headers = {"X-Speech-STT-Engine": stt.name, "X-Speech-Duration": f"{transcript.duration_s:.3f}"}
                return transcript_response(transcript, response_format, headers)
        fields: dict[str, str] = {"model": "whisper-1" if _wants_voicestudio(model) else (model or "whisper-1")}
        if lang:
            fields["language"] = lang
        if prompt:
            fields["prompt"] = prompt
        if response_format:
            fields["response_format"] = response_format
        if temperature is not None:
            fields["temperature"] = str(temperature)
        try:
            upstream = await voicestudio.transcribe(
                file=data,
                filename=file.filename or "audio.webm",
                content_type=file.content_type or "application/octet-stream",
                fields=fields,
            )
        except VoiceStudioError as exc:
            return openai_error(exc.status, exc.message, code="voicestudio_error")
        log.info("transcribed %d bytes with VoiceStudio in %.2fs", len(data), time.perf_counter() - started)
        return Response(
            content=upstream.content,
            status_code=200,
            media_type=upstream.headers.get("content-type", "application/json"),
            headers={"X-Speech-STT-Engine": "voicestudio"},
        )

    return app


__all__ = ["create_app", "SpeechRequest", "FORMATS"]
