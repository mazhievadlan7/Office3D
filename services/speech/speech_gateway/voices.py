"""The voice catalogue: `<engine>:<name>` ids, presets from voices.json.

A preset names an engine and everything that engine needs to sound the same
every time (a VoiceStudio model, a voice-design description and a seed, or a
Silero speaker). A VoiceStudio preset may carry a `reference`: a short clip of
the designed voice (services/speech/voice-refs/, synthetic, made with VoxCPM2
voice design) that VoiceStudio clones, so the timbre is the same on every
line. It may name a Silero `fallback`, spoken when VoiceStudio is down — so a
CPU-only server without VoiceStudio still talks. `fx` names the
post-processing preset (fx.py) the voice is heard through, fallback included.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .fx import is_fx_preset

ENGINES = ("silero", "voicestudio")
VOICE_ID_RE = re.compile(r"^(silero|voicestudio):([A-Za-z0-9_.-]{1,80})$")
#: Silero v5 Russian speakers the office offers (the `silero_model`, v5_5_ru
#: by default). The office speaks with male voices only.
SILERO_SPEAKERS = ("aidar", "eugene")
#: Male Russian speakers of Silero's CIS model (v5_cis_base, MIT): more distinct
#: voices for the crew's fallbacks. Loaded only once one of them speaks.
SILERO_CIS_SPEAKERS = (
    "ru_alexandr", "ru_bogdan", "ru_dmitriy", "ru_eduard", "ru_gamat", "ru_igor", "ru_marat", "ru_roman",
    "ru_safarhuja", "ru_sibday",
)
ALL_SILERO_SPEAKERS = SILERO_SPEAKERS + SILERO_CIS_SPEAKERS
#: Female speakers the office no longer offers: saved settings naming them
#: are spoken by this male voice instead of failing.
RETIRED_SILERO_SPEAKERS = (
    "baya", "kseniya", "xenia",
    "ru_aigul", "ru_albina", "ru_alfia", "ru_alfia2", "ru_ekaterina", "ru_karina", "ru_kejilgan", "ru_kermen",
    "ru_miyau", "ru_nurgul", "ru_oksana", "ru_onaoy", "ru_ramilia", "ru_saida", "ru_vika", "ru_zara",
    "ru_zhadyra", "ru_zhazira", "ru_zinaida",
)
RETIRED_SILERO_REPLACEMENT = "silero:aidar"
#: The retired female crew voices, each to a fixed male crew voice.
RETIRED_VOICESTUDIO_VOICES = {
    "voicestudio:crew-f1": "voicestudio:crew-m1",
    "voicestudio:crew-f2": "voicestudio:crew-m2",
}
SILERO_LABELS = {
    "aidar": "Айдар",
    "eugene": "Евгений",
}
#: OpenAI voice names mean "the default voice" here.
OPENAI_VOICE_NAMES = frozenset(
    {"alloy", "ash", "ballad", "cedar", "coral", "echo", "fable", "marin", "nova", "onyx", "sage", "shimmer", "verse"}
)
_REFERENCE_FILE_RE = re.compile(r"^[A-Za-z0-9_.-]{1,80}\.(flac|wav)$")


class UnknownVoice(ValueError):
    pass


def replacement_for_retired(voice_id: str) -> str | None:
    """The male voice that speaks for a retired (female) voice id, else None."""
    if voice_id in RETIRED_VOICESTUDIO_VOICES:
        return RETIRED_VOICESTUDIO_VOICES[voice_id]
    engine, _, name = voice_id.partition(":")
    if engine == "silero" and name in RETIRED_SILERO_SPEAKERS:
        return RETIRED_SILERO_REPLACEMENT
    return None


def is_cis_speaker(speaker: str) -> bool:
    return speaker in SILERO_CIS_SPEAKERS


@dataclass(frozen=True)
class Reference:
    """A clip of the voice for VoiceStudio to clone: a file in voice-refs/ and its exact transcript."""

    file: str
    text: str


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
    #: Post-processing preset (fx.FX_PRESETS): none, humanoid, humanoid-light.
    fx: str = "none"
    reference: Reference | None = None
    #: "male" (the office speaks with male voices only).
    gender: str | None = None

    def public(self) -> dict[str, Any]:
        out: dict[str, Any] = {"id": self.id, "engine": self.engine, "label": self.label, "role": self.role}
        if self.description:
            out["description"] = self.description
        if self.fallback:
            out["fallback"] = self.fallback
        if self.fx != "none":
            out["fx"] = self.fx
        if self.gender:
            out["gender"] = self.gender
        return out

    def cache_identity(self) -> dict[str, Any]:
        identity: dict[str, Any] = {"id": self.id, "engine": self.engine, "params": self.params}
        if self.reference:
            identity["reference"] = {"file": self.reference.file, "text": self.reference.text}
        return identity


def _silero_label(speaker: str) -> str:
    if speaker in SILERO_LABELS:
        return f"{SILERO_LABELS[speaker]} (Silero)"
    return f"{speaker.removeprefix('ru_').capitalize()} (Silero CIS)"


def _silero_voice(speaker: str, role: str = "any", label: str | None = None) -> Voice:
    return Voice(
        id=f"silero:{speaker}",
        engine="silero",
        name=speaker,
        label=label or _silero_label(speaker),
        role=role,
        params={"speaker": speaker},
    )


class VoiceCatalog:
    def __init__(self, presets: list[Voice], default_voice: str, voicestudio_model: str) -> None:
        self._presets = {voice.id: voice for voice in presets}
        self.voicestudio_model = voicestudio_model
        for speaker in SILERO_SPEAKERS:
            self._presets.setdefault(f"silero:{speaker}", _silero_voice(speaker))
        # The CIS speakers named as fallbacks are listed too (the rest resolve on request).
        for voice in presets:
            if voice.fallback and voice.fallback not in self._presets:
                name = voice.fallback.split(":", 1)[1]
                if name in ALL_SILERO_SPEAKERS:
                    self._presets[voice.fallback] = _silero_voice(name)
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
        replacement = replacement_for_retired(value)
        if replacement is not None:
            # A retired female voice (an old saved setting): its male stand-in,
            # or the default when the stand-in is not in this catalogue.
            if replacement in self._presets:
                return self._presets[replacement]
            if replacement.startswith("silero:"):
                return _silero_voice(replacement.split(":", 1)[1])
            return self.resolve(self.default_voice)
        match = VOICE_ID_RE.match(value)
        if not match:
            raise UnknownVoice(f"Unknown voice '{value}'. Use <engine>:<name>, engines: {', '.join(ENGINES)}.")
        engine, name = match.groups()
        if engine == "silero":
            if name not in ALL_SILERO_SPEAKERS:
                raise UnknownVoice(f"Unknown Silero speaker '{name}'. Speakers: {', '.join(ALL_SILERO_SPEAKERS)}.")
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
        if params["speaker"] not in ALL_SILERO_SPEAKERS:
            raise ValueError(f"voices.json: {voice_id} names unknown Silero speaker {params['speaker']!r}")
    fallback = raw.get("fallback")
    if fallback is not None and not (isinstance(fallback, str) and fallback.startswith("silero:")):
        raise ValueError(f"voices.json: {voice_id} fallback must be a silero voice")
    fx = str(raw.get("fx") or "none")
    if not is_fx_preset(fx):
        raise ValueError(f"voices.json: {voice_id} names unknown fx preset {fx!r}")
    reference = None
    ref = raw.get("reference")
    if ref is not None:
        if engine != "voicestudio" or not isinstance(ref, dict):
            raise ValueError(f"voices.json: {voice_id}: only a VoiceStudio voice takes a reference {{file, text}}")
        file = str(ref.get("file") or "")
        text = " ".join(str(ref.get("text") or "").split())
        if not _REFERENCE_FILE_RE.match(file) or not text:
            raise ValueError(f"voices.json: {voice_id}: a reference needs a file (name.flac or .wav) and its text")
        reference = Reference(file=file, text=text)
    gender = raw.get("gender")
    if gender not in (None, "male"):
        raise ValueError(f"voices.json: {voice_id}: the office offers male voices only (gender must be male)")
    return Voice(
        id=voice_id,
        engine=engine,
        name=name,
        label=str(raw.get("label") or name),
        role=str(raw.get("role") or "any"),
        description=raw.get("description"),
        params=params,
        fallback=fallback,
        fx=fx,
        reference=reference,
        gender=gender,
    )
