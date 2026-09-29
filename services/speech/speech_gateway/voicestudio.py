"""Client for a VoiceStudio backend's OpenAI-compatible API (`/v1/...`).

VoiceStudio (AGPL-3.0) runs as its own process; this module only speaks HTTP
to it. Speech is always requested as WAV and re-encoded by the gateway, so the
cache and the formats are the same for every engine and VoiceStudio needs no
ffmpeg for it.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import httpx

from .audio import Audio, decode

log = logging.getLogger("speech.voicestudio")


class VoiceStudioError(Exception):
    """VoiceStudio refused or failed. `status` is what the gateway answers."""

    def __init__(self, status: int, message: str, *, unreachable: bool = False) -> None:
        super().__init__(message)
        self.status = status
        self.message = message
        self.unreachable = unreachable


def _upstream_message(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return response.text[:300]
    if isinstance(body, dict):
        error = body.get("error")
        if isinstance(error, dict) and error.get("message"):
            return str(error["message"])[:300]
        if body.get("detail"):
            return str(body["detail"])[:300]
    return str(body)[:300]


class VoiceStudioClient:
    name = "voicestudio"

    def __init__(
        self,
        base_url: str,
        *,
        api_key: str = "",
        timeout_s: float = 300.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self._transport = transport
        self._headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        self.timeout_s = timeout_s
        self.reachable: bool | None = None
        #: Voice profiles made for reference clips: name -> (id, when last seen).
        self._profiles: dict[str, tuple[str, float]] = {}
        self._profile_lock = asyncio.Lock()
        #: How long a known profile is trusted before it is looked up again
        #: (someone may delete it in VoiceStudio's own interface).
        self.profile_ttl_s = 600.0

    def _client(self, timeout: float) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=self.base_url, headers=self._headers, timeout=timeout, transport=self._transport
        )

    async def health(self) -> dict[str, Any]:
        try:
            async with self._client(3.0) as client:
                response = await client.get("/health")
            self.reachable = response.status_code < 500
            return {"reachable": self.reachable, "status": response.status_code, "url": self.base_url}
        except httpx.HTTPError as exc:
            self.reachable = False
            return {"reachable": False, "url": self.base_url, "error": type(exc).__name__}

    async def synthesize(
        self, text: str, params: dict[str, Any], speed: float = 1.0, *, timeout_s: float | None = None
    ) -> Audio:
        body: dict[str, Any] = {
            "model": params.get("model") or "voxcpm2",
            "input": text,
            "voice": params.get("voice") or "default",
            "response_format": "wav",
            "speed": speed,
        }
        for key in ("language", "description", "instruct", "seed", "num_step", "guidance_scale", "denoise"):
            if params.get(key) is not None:
                body[key] = params[key]
        try:
            async with self._client(timeout_s or self.timeout_s) as client:
                response = await client.post("/v1/audio/speech", json=body)
        except httpx.TimeoutException as exc:
            raise VoiceStudioError(504, "VoiceStudio did not answer in time.", unreachable=True) from exc
        except httpx.HTTPError as exc:
            self.reachable = False
            raise VoiceStudioError(503, "VoiceStudio is not reachable.", unreachable=True) from exc
        self.reachable = True
        if response.status_code >= 400:
            message = _upstream_message(response)
            log.warning("VoiceStudio speech %s: %s", response.status_code, message)
            status = 400 if response.status_code in (400, 404, 422) else 502
            raise VoiceStudioError(status, f"VoiceStudio: {message}", unreachable=response.status_code >= 500)
        return decode(response.content)

    async def ensure_profile(
        self, name: str, *, wav: bytes, text: str, seed: int | None, language: str | None
    ) -> str:
        """The id of VoiceStudio's voice profile `name` (a clone of `wav`), made once.

        The name carries the clip's hash, so a new take gets a new profile and
        an old one is never reused for it.
        """
        known = self._profiles.get(name)
        if known and time.monotonic() - known[1] < self.profile_ttl_s:
            return known[0]
        async with self._profile_lock:
            known = self._profiles.get(name)
            if known and time.monotonic() - known[1] < self.profile_ttl_s:
                return known[0]
            try:
                async with self._client(60.0) as client:
                    listed = await client.get("/profiles")
                    if listed.status_code >= 400:
                        raise VoiceStudioError(502, f"VoiceStudio profiles: {_upstream_message(listed)}")
                    rows = listed.json()
                    found = next(
                        (row for row in rows if isinstance(row, dict) and row.get("name") == name and row.get("id")),
                        None,
                    )
                    if found is None:
                        form = {"name": name, "ref_text": text, "kind": "clone", "language": language or "Auto"}
                        if seed is not None:
                            form["seed"] = str(seed)
                        created = await client.post(
                            "/profiles", data=form, files={"ref_audio": (f"{name}.wav", wav, "audio/wav")}
                        )
                        if created.status_code >= 400:
                            raise VoiceStudioError(502, f"VoiceStudio profile: {_upstream_message(created)}")
                        found = created.json()
                        log.info("VoiceStudio voice profile %s created (%s)", name, found.get("id"))
            except httpx.TimeoutException as exc:
                raise VoiceStudioError(504, "VoiceStudio did not answer in time.", unreachable=True) from exc
            except httpx.HTTPError as exc:
                self.reachable = False
                raise VoiceStudioError(503, "VoiceStudio is not reachable.", unreachable=True) from exc
            except ValueError as exc:
                raise VoiceStudioError(502, "VoiceStudio answered the profile request with something unexpected.") from exc
            profile_id = str(found.get("id") or "") if isinstance(found, dict) else ""
            if not profile_id:
                raise VoiceStudioError(502, "VoiceStudio made no voice profile.")
            self._profiles[name] = (profile_id, time.monotonic())
            return profile_id

    async def transcribe(
        self,
        *,
        file: bytes,
        filename: str,
        content_type: str,
        fields: dict[str, str],
    ) -> httpx.Response:
        files = {"file": (filename, file, content_type or "application/octet-stream")}
        try:
            # Recognition has no fallback, so it may take a little longer than
            # speech — still inside the office's 120 s limit.
            async with self._client(max(self.timeout_s, 115.0)) as client:
                response = await client.post("/v1/audio/transcriptions", data=fields, files=files)
        except httpx.TimeoutException as exc:
            raise VoiceStudioError(504, "VoiceStudio did not answer in time.", unreachable=True) from exc
        except httpx.HTTPError as exc:
            self.reachable = False
            raise VoiceStudioError(503, "VoiceStudio is not reachable.", unreachable=True) from exc
        self.reachable = True
        if response.status_code >= 400:
            message = _upstream_message(response)
            log.warning("VoiceStudio transcription %s: %s", response.status_code, message)
            status = 400 if response.status_code in (400, 413, 415, 422) else 502
            raise VoiceStudioError(status, f"VoiceStudio: {message}")
        return response
