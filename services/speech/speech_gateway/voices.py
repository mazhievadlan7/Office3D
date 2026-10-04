"""The voice catalogue: `silero:<name>` ids, presets from voices.json.

Every voice is Silero on the CPU. A preset names a Silero speaker and the
post-processing (`fx`, fx.py) it is heard through, so a voice sounds the same
every time. Ids of voices the office no longer offers still resolve: the
designed voices of the retired VoiceStudio engine (voicestudio:am7,
voicestudio:crew-m1..m6: an old saved setting, the voice bank's manifest) to
the Silero presets of the same name, retired female voices to male ones.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .fx import is_fx_preset

ENGINES = ("silero",)
VOICE_ID_RE = re.compile(r"^(silero):([A-Za-z0-9_.-]{1,80})$")
#: Ids of the retired VoiceStudio engine: still accepted, never an error.
LEGACY_VOICE_ID_RE = re.compile(r"^voicestudio:([A-Za-z0-9_.-]{1,80})$")
#: Silero v5 Russian speakers the office offers (the `silero_model`, v5_5_ru
#: by default). The office speaks with male voices only.
SILERO_SPEAKERS = ("aidar", "eugene")
#: Male Russian speakers of Silero's CIS model (v5_cis_base, MIT): more distinct
#: voices for AM7 and the crew. Loaded only once one of them speaks.
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
#: The retired VoiceStudio voices, each to the Silero preset that speaks for it
#: (the retired female crew voices to fixed male ones).
RETIRED_VOICESTUDIO_VOICES = {
    "voicestudio:am7": "silero:am7",
    **{f"voicestudio:crew-m{n}": f"silero:crew-m{n}" for n in range(1, 7)},
    "voicestudio:crew-f1": "silero:crew-m1",
    "voicestudio:crew-f2": "silero:crew-m2",
}
SILERO_LABELS = {
    "aidar": "Айдар",
    "eugene": "Евгений",
}
#: OpenAI voice names mean "the default voice" here.
OPENAI_VOICE_NAMES = frozenset(
    {"alloy", "ash", "ballad", "cedar", "coral", "echo", "fable", "marin", "nova", "onyx", "sage", "shimmer", "verse"}
)


class UnknownVoice(ValueError):
    pass


def replacement_for_retired(voice_id: str) -> str | None:
    """The voice that speaks for a retired id (a VoiceStudio or a female voice), else None."""
    if voice_id in RETIRED_VOICESTUDIO_VOICES:
        return RETIRED_VOICESTUDIO_VOICES[voice_id]
    engine, _, name = voice_id.partition(":")
    if engine == "silero" and name in RETIRED_SILERO_SPEAKERS:
        return RETIRED_SILERO_REPLACEMENT
    return None


def is_cis_speaker(speaker: str) -> bool:
    return speaker in SILERO_CIS_SPEAKERS


@dataclass(frozen=True)
class Voice:
    id: str
    engine: str
    name: str
    label: str
    role: str = "any"  # system | lead | crew | any
    description: str | None = None
    #: {"speaker": <Silero speaker>}.
    params: dict[str, Any] = field(default_factory=dict)
    #: Post-processing preset (fx.FX_PRESETS).
    fx: str = "none"
    #: "male" (the office speaks with male voices only).
    gender: str | None = None

    def public(self) -> dict[str, Any]:
        out: dict[str, Any] = {"id": self.id, "engine": self.engine, "label": self.label, "role": self.role}
        if self.description:
            out["description"] = self.description
        if self.fx != "none":
            out["fx"] = self.fx
        if self.gender:
            out["gender"] = self.gender
        return out

    def cache_identity(self) -> dict[str, Any]:
        return {"id": self.id, "engine": self.engine, "params": self.params}


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
    def __init__(self, presets: list[Voice], default_voice: str) -> None:
        self._presets = {voice.id: voice for voice in presets}
        for speaker in SILERO_SPEAKERS:
            self._presets.setdefault(f"silero:{speaker}", _silero_voice(speaker))
        self.default_voice = default_voice if default_voice in self._presets or VOICE_ID_RE.match(default_voice) else "silero:aidar"

    @classmethod
    def load(cls, path: Path | None, default_voice: str) -> "VoiceCatalog":
        presets: list[Voice] = []
        if path and path.is_file():
            data = json.loads(path.read_text(encoding="utf-8"))
            for raw in data.get("voices", []):
                presets.append(parse_preset(raw))
        return cls(presets, default_voice)

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
            # A retired voice (an old saved setting): its stand-in, or the
            # default when the stand-in is not in this catalogue.
            if replacement in self._presets:
                return self._presets[replacement]
            name = replacement.split(":", 1)[1]
            if name in ALL_SILERO_SPEAKERS:
                return _silero_voice(name)
            return self.resolve(self.default_voice)
        if LEGACY_VOICE_ID_RE.match(value):
            # Any other voice of the retired VoiceStudio engine: the default voice.
            return self.resolve(self.default_voice)
        match = VOICE_ID_RE.match(value)
        if not match:
            raise UnknownVoice(f"Unknown voice '{value}'. Use <engine>:<name>, engines: {', '.join(ENGINES)}.")
        name = match.group(2)
        if name not in ALL_SILERO_SPEAKERS:
            raise UnknownVoice(f"Unknown Silero speaker '{name}'. Speakers: {', '.join(ALL_SILERO_SPEAKERS)}.")
        return _silero_voice(name)


def parse_preset(raw: dict[str, Any]) -> Voice:
    voice_id = str(raw.get("id", ""))
    match = VOICE_ID_RE.match(voice_id)
    if not match:
        raise ValueError(f"voices.json: bad voice id {voice_id!r} (silero:<name>)")
    engine, name = match.groups()
    params = dict(raw.get("params") or {})
    params.setdefault("speaker", name)
    if params["speaker"] not in ALL_SILERO_SPEAKERS:
        raise ValueError(f"voices.json: {voice_id} names unknown Silero speaker {params['speaker']!r}")
    fx = str(raw.get("fx") or "none")
    if not is_fx_preset(fx):
        raise ValueError(f"voices.json: {voice_id} names unknown fx preset {fx!r}")
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
        fx=fx,
        gender=gender,
    )
