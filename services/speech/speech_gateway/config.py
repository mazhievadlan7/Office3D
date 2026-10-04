"""Settings from the environment. Nothing here is secret."""

from __future__ import annotations

import ipaddress
import os
from dataclasses import dataclass, field
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent
SERVICE_DIR = PACKAGE_DIR.parent


def _default_home() -> Path:
    explicit = os.environ.get("OFFICE3D_SPEECH_HOME", "").strip()
    if explicit:
        return Path(explicit).expanduser()
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "office3d-speech"
    base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(base) / "office3d-speech"


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, "").strip() or default


def _env_int(name: str, default: int) -> int:
    try:
        return int(_env(name, str(default)))
    except ValueError:
        return default


def _env_bool(name: str, default: bool) -> bool:
    value = _env(name).lower()
    if not value:
        return default
    return value in {"1", "true", "yes", "on"}


def is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


@dataclass(frozen=True)
class Settings:
    host: str = "127.0.0.1"
    port: int = 8765
    #: The voice used for "default", an OpenAI voice name, or no voice at all.
    default_voice: str = "silero:aidar"
    silero_model: str = "v5_5_ru"
    #: Silero's CIS model (MIT): the ru_* speakers AM7 and the crew use.
    silero_cis_model: str = "v5_cis_base"
    silero_model_url: str = "https://models.silero.ai/models/tts/ru/{model}.pt"
    #: cpu (default: fast enough, leaves the GPU to the HQ's 3D), cuda or auto.
    silero_device: str = "cpu"
    silero_threads: int = 4
    silero_sample_rate: int = 48_000
    home: Path = field(default_factory=_default_home)
    voices_file: Path = SERVICE_DIR / "voices.json"
    lexicon_file: Path = SERVICE_DIR / "lexicon.json"
    #: Stress-marked phrases (homographs in the office's own lines): stress.json.
    stress_file: Path = SERVICE_DIR / "stress.json"
    #: This machine's own additions, kept out of the repository (names of real
    #: people: the owner's name and patronymic, stressed). Default: the speech
    #: home's lexicon.local.json and stress.local.json; a missing file is fine.
    lexicon_local_file: Path | None = None
    stress_local_file: Path | None = None
    cache_enabled: bool = True
    cache_max_mb: int = 512
    max_input_chars: int = 5_000
    max_upload_mb: int = 25
    #: Language hint for transcriptions when the caller sends none.
    stt_language: str = "ru"
    stt_model: str = "gigaam-v3-e2e-rnnt"
    #: "" (full precision) or int8 (4x smaller, a little faster).
    stt_quantization: str = ""
    stt_threads: int = 4
    stt_vad: bool = True
    #: A local directory with the model files (offline installs); else HF_HOME.
    stt_model_dir: Path | None = None
    #: Load Silero (and GigaAM) at start-up so the first phrase is not slow.
    warmup: bool = True

    @property
    def lexicon_local(self) -> Path:
        return self.lexicon_local_file or self.home / "lexicon.local.json"

    @property
    def stress_local(self) -> Path:
        return self.stress_local_file or self.home / "stress.local.json"

    @property
    def models_dir(self) -> Path:
        return self.home / "models"

    @property
    def cache_dir(self) -> Path:
        return self.home / "cache" / "tts"

    def use_hf_home(self) -> None:
        """Hugging Face downloads (GigaAM, Silero VAD) go under the speech home,
        unless HF_HOME is set already."""
        os.environ.setdefault("HF_HOME", str(self.home / "hf"))
        os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

    @classmethod
    def from_env(cls) -> "Settings":
        home = _default_home()
        voices_file = _env("SPEECH_VOICES_FILE")
        lexicon_file = _env("SPEECH_LEXICON_FILE")
        stress_file = _env("SPEECH_STRESS_FILE")
        lexicon_local_file = _env("SPEECH_LEXICON_LOCAL_FILE")
        stress_local_file = _env("SPEECH_STRESS_LOCAL_FILE")
        stt_model_dir = _env("SPEECH_STT_MODEL_DIR")
        return cls(
            host=_env("SPEECH_HOST", "127.0.0.1"),
            port=_env_int("SPEECH_PORT", 8765),
            default_voice=_env("SPEECH_DEFAULT_VOICE", "silero:aidar"),
            silero_model=_env("SILERO_MODEL", "v5_5_ru"),
            silero_cis_model=_env("SILERO_CIS_MODEL", "v5_cis_base"),
            silero_model_url=_env("SILERO_MODEL_URL", "https://models.silero.ai/models/tts/ru/{model}.pt"),
            silero_device=_env("SILERO_DEVICE", "cpu").lower(),
            silero_threads=max(1, _env_int("SILERO_THREADS", 4)),
            home=home,
            voices_file=Path(voices_file) if voices_file else SERVICE_DIR / "voices.json",
            lexicon_file=Path(lexicon_file) if lexicon_file else SERVICE_DIR / "lexicon.json",
            stress_file=Path(stress_file) if stress_file else SERVICE_DIR / "stress.json",
            lexicon_local_file=Path(lexicon_local_file).expanduser() if lexicon_local_file else None,
            stress_local_file=Path(stress_local_file).expanduser() if stress_local_file else None,
            cache_enabled=_env_bool("SPEECH_CACHE", True),
            cache_max_mb=max(0, _env_int("SPEECH_CACHE_MAX_MB", 512)),
            max_input_chars=max(1, _env_int("SPEECH_MAX_INPUT_CHARS", 5_000)),
            max_upload_mb=max(1, _env_int("SPEECH_MAX_UPLOAD_MB", 25)),
            stt_language=_env("SPEECH_STT_LANGUAGE", "ru"),
            stt_model=_env("SPEECH_STT_MODEL", "gigaam-v3-e2e-rnnt"),
            stt_quantization=_env("SPEECH_STT_QUANTIZATION").lower(),
            stt_threads=max(1, _env_int("SPEECH_STT_THREADS", 4)),
            stt_vad=_env_bool("SPEECH_STT_VAD", True),
            stt_model_dir=Path(stt_model_dir).expanduser() if stt_model_dir else None,
            warmup=_env_bool("SPEECH_WARMUP", True),
        )

    def check_bind(self) -> None:
        """The gateway listens on loopback. A container may opt out explicitly."""
        if is_loopback(self.host):
            return
        if _env_bool("SPEECH_ALLOW_NON_LOOPBACK", False):
            return
        raise SystemExit(
            f"Refusing to bind {self.host}: the speech gateway listens on 127.0.0.1 only. "
            "Inside a container network set SPEECH_ALLOW_NON_LOOPBACK=1 and publish no port."
        )
