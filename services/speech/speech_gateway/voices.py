"""The voice catalogue: `<engine>:<name>` ids, presets from voices.json.

A preset names an engine and everything that engine needs to sound the same
every time (a VoiceStudio model, a voice-design description and a seed, or a
Silero speaker). A VoiceStudio preset may name a Silero `fallback`, spoken when
VoiceStudio is down — so a CPU-only server without VoiceStudio still talks.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

ENGINES = ("silero", "voicestudio")
VOICE_ID_RE = re.compile(r"^(silero|voicestudio):([A-Za-z0-9_.-]{1,80})$")
SILERO_SPEAKERS = ("aidar", "baya", "kseniya", "xenia", "eugene")
SILERO_LABELS = {
    "aidar": "Айдар",
    "baya": "Бая",
    "kseniya": "Ксения",
    "xenia": "Ксения (светлый)",
    "eugene": "Евгений",
}
#: OpenAI voice names mean "the default voice" here.
OPENAI_VOICE_NAMES = frozenset(
    {"alloy", "ash", "ballad", "cedar", "coral", "echo", "fable", "marin", "nova", "onyx", "sage", "shimmer", "verse"}
)


class UnknownVoice(ValueError):
    pass


@dataclass(frozen=True)
class Voice:
    id: str
    engine: str
    name: str
    label: str
    role: str = "any"  # system | lead | crew | any
    description: str | None = None
    #: silero: speaker. voicestudio: request fields (model, voice, description, seed, language, instruct).
    params: dict[str, Any] = field(default_factory=dict)
    fallback: str | None = None

    def public(self) -> dict[str, Any]:
        out: dict[str, Any] = {"id": self.id, "engine": self.engine, "label": self.label, "role": self.role}
        if self.description:
            out["description"] = self.description
        if self.fallback:
            out["fallback"] = self.fallback
        return out

    def cache_identity(self) -> dict[str, Any]:
        return {"id": self.id, "engine": self.engine, "params": self.params}


def _silero_voice(speaker: str, role: str = "any", label: str | None = None) -> Voice:
    return Voice(
        id=f"silero:{speaker}",
        engine="silero",
        name=speaker,
        label=label or f"{SILERO_LABELS.get(speaker, speaker)} (Silero)",
        role=role,
        params={"speaker": speaker},
    )


class VoiceCatalog:
    def __init__(self, presets: list[Voice], default_voice: str, voicestudio_model: str) -> None:
        self._presets = {voice.id: voice for voice in presets}
        self.voicestudio_model = voicestudio_model
        for speaker in SILERO_SPEAKERS:
            self._presets.setdefault(f"silero:{speaker}", _silero_voice(speaker))
        self.default_voice = default_voice if default_voice in self._presets or VOICE_ID_RE.match(default_voice) else "silero:aidar"

    @classmethod
    def load(cls, path: Path | None, default_voice: str, voicestudio_model: str) -> "VoiceCatalog":
        presets: list[Voice] = []
        if path and path.is_file():
            data = json.loads(path.read_text(encoding="utf-8"))
            for raw in data.get("voices", []):
                presets.append(parse_preset(raw))
        return cls(presets, default_voice, voicestudio_model)

    def list(self) -> list[Voice]:
        return list(self._presets.values())

    def resolve(self, requested: str | None) -> Voice:
        value = (requested or "").strip()
        if not value or value == "default" or value in OPENAI_VOICE_NAMES:
            value = self.default_voice
        if value in self._presets:
            return self._presets[value]
        match = VOICE_ID_RE.match(value)
        if not match:
            raise UnknownVoice(f"Unknown voice '{value}'. Use <engine>:<name>, engines: {', '.join(ENGINES)}.")
        engine, name = match.groups()
        if engine == "silero":
            if name not in SILERO_SPEAKERS:
                raise UnknownVoice(f"Unknown Silero speaker '{name}'. Speakers: {', '.join(SILERO_SPEAKERS)}.")
            return _silero_voice(name)
        # Any other VoiceStudio voice: a voice-profile id or an engine preset there.
        return Voice(
            id=value,
            engine="voicestudio",
            name=name,
            label=name,
            params={"model": self.voicestudio_model, "voice": name, "language": "ru"},
        )


def parse_preset(raw: dict[str, Any]) -> Voice:
    voice_id = str(raw.get("id", ""))
    match = VOICE_ID_RE.match(voice_id)
    if not match:
        raise ValueError(f"voices.json: bad voice id {voice_id!r}")
    engine, name = match.groups()
    params = dict(raw.get("params") or {})
    if engine == "silero":
        params.setdefault("speaker", name)
        if params["speaker"] not in SILERO_SPEAKERS:
            raise ValueError(f"voices.json: {voice_id} names unknown Silero speaker {params['speaker']!r}")
    fallback = raw.get("fallback")
    if fallback is not None and not (isinstance(fallback, str) and fallback.startswith("silero:")):
        raise ValueError(f"voices.json: {voice_id} fallback must be a silero voice")
    return Voice(
        id=voice_id,
        engine=engine,
        name=name,
        label=str(raw.get("label") or name),
        role=str(raw.get("role") or "any"),
        description=raw.get("description"),
        params=params,
        fallback=fallback,
    )
