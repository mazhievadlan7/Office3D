"""Settings from the environment. Nothing here is secret except the optional
VoiceStudio key, which is only ever sent to VoiceStudio and never logged."""

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


def _env_float(name: str, default: float) -> float:
    try:
        return float(_env(name, str(default)))
    except ValueError:
        return default


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
    #: VoiceStudio's backend (OpenAI-compatible under /v1).
    voicestudio_url: str = "http://127.0.0.1:3900"
    voicestudio_api_key: str = field(default="", repr=False)
    voicestudio_model: str = "voxcpm2"
    #: Past this the gateway speaks the voice's Silero fallback instead (a cold
    #: VoxCPM2 load, weights still downloading). Keep it below the office's
    #: own 120 s limit.
    voicestudio_timeout_s: float = 90.0
    #: After VoiceStudio fails to answer, voices with a Silero fallback use it
    #: straight away for this long instead of waiting for the timeout again.
    voicestudio_backoff_s: float = 60.0
    #: The voice used for "default", an OpenAI voice name, or no voice at all.
    default_voice: str = "silero:aidar"
    silero_model: str = "v5_5_ru"
    silero_model_url: str = "https://models.silero.ai/models/tts/ru/{model}.pt"
    #: cpu (default: fast enough, leaves the GPU to VoiceStudio), cuda or auto.
    silero_device: str = "cpu"
    silero_threads: int = 4
    silero_sample_rate: int = 48_000
    home: Path = field(default_factory=_default_home)
    voices_file: Path = SERVICE_DIR / "voices.json"
    lexicon_file: Path = SERVICE_DIR / "lexicon.json"
    cache_enabled: bool = True
    cache_max_mb: int = 512
    max_input_chars: int = 5_000
    max_upload_mb: int = 25
    #: Language hint for transcriptions when the caller sends none.
    stt_language: str = "ru"
    #: Who recognises speech: gigaam (in this process, CPU) or voicestudio
    #: (VoiceStudio's Whisper; slow while VoxCPM2 holds the GPU).
    stt_engine: str = "gigaam"
    stt_model: str = "gigaam-v3-e2e-rnnt"
    #: "" (full precision) or int8 (4x smaller, a little faster).
    stt_quantization: str = ""
    stt_threads: int = 4
    stt_vad: bool = True
    #: A local directory with the model files (offline installs); else HF_HOME.
    stt_model_dir: Path | None = None
    #: When GigaAM cannot run (not installed, failed to load, a language other
    #: than Russian) forward the recording to VoiceStudio instead.
    stt_fallback: bool = True
    #: Load Silero (and GigaAM) at start-up so the first phrase is not slow.
    warmup: bool = True
    #: At start-up, also speak one phrase through the lead voice's VoiceStudio
    #: engine, so VoxCPM2 is on the GPU before AM7's first line.
    voicestudio_warmup: bool = True
    #: How long that first phrase may take (a cold VoxCPM2 load is ~1.5 min).
    voicestudio_warmup_timeout_s: float = 600.0

    @property
    def models_dir(self) -> Path:
        return self.home / "models"

    @property
    def cache_dir(self) -> Path:
        return self.home / "cache" / "tts"

    def use_hf_home(self) -> None:
        """Hugging Face downloads (GigaAM, Silero VAD) go under the speech home,
        next to VoiceStudio's, unless HF_HOME is set already."""
        os.environ.setdefault("HF_HOME", str(self.home / "hf"))
        os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

    @classmethod
    def from_env(cls) -> "Settings":
        home = _default_home()
        voices_file = _env("SPEECH_VOICES_FILE")
        lexicon_file = _env("SPEECH_LEXICON_FILE")
        stt_model_dir = _env("SPEECH_STT_MODEL_DIR")
        stt_engine = _env("SPEECH_STT_ENGINE", "gigaam").lower()
        return cls(
            host=_env("SPEECH_HOST", "127.0.0.1"),
            port=_env_int("SPEECH_PORT", 8765),
            voicestudio_url=_env("VOICESTUDIO_URL", "http://127.0.0.1:3900").rstrip("/"),
            voicestudio_api_key=_env("VOICESTUDIO_API_KEY"),
            voicestudio_model=_env("VOICESTUDIO_MODEL", "voxcpm2"),
            voicestudio_timeout_s=_env_float("VOICESTUDIO_TIMEOUT_S", 90.0),
            voicestudio_backoff_s=max(0.0, _env_float("VOICESTUDIO_BACKOFF_S", 60.0)),
            default_voice=_env("SPEECH_DEFAULT_VOICE", "silero:aidar"),
            silero_model=_env("SILERO_MODEL", "v5_5_ru"),
            silero_model_url=_env("SILERO_MODEL_URL", "https://models.silero.ai/models/tts/ru/{model}.pt"),
            silero_device=_env("SILERO_DEVICE", "cpu").lower(),
            silero_threads=max(1, _env_int("SILERO_THREADS", 4)),
            home=home,
            voices_file=Path(voices_file) if voices_file else SERVICE_DIR / "voices.json",
            lexicon_file=Path(lexicon_file) if lexicon_file else SERVICE_DIR / "lexicon.json",
            cache_enabled=_env_bool("SPEECH_CACHE", True),
            cache_max_mb=max(0, _env_int("SPEECH_CACHE_MAX_MB", 512)),
            max_input_chars=max(1, _env_int("SPEECH_MAX_INPUT_CHARS", 5_000)),
            max_upload_mb=max(1, _env_int("SPEECH_MAX_UPLOAD_MB", 25)),
            stt_language=_env("SPEECH_STT_LANGUAGE", "ru"),
            stt_engine=stt_engine if stt_engine in ("gigaam", "voicestudio") else "gigaam",
            stt_model=_env("SPEECH_STT_MODEL", "gigaam-v3-e2e-rnnt"),
            stt_quantization=_env("SPEECH_STT_QUANTIZATION").lower(),
            stt_threads=max(1, _env_int("SPEECH_STT_THREADS", 4)),
            stt_vad=_env_bool("SPEECH_STT_VAD", True),
            stt_model_dir=Path(stt_model_dir).expanduser() if stt_model_dir else None,
            stt_fallback=_env_bool("SPEECH_STT_FALLBACK", True),
            warmup=_env_bool("SPEECH_WARMUP", True),
            voicestudio_warmup=_env_bool("SPEECH_VOICESTUDIO_WARMUP", True),
            voicestudio_warmup_timeout_s=max(10.0, _env_float("SPEECH_VOICESTUDIO_WARMUP_TIMEOUT_S", 600.0)),
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
