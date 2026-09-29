"""Office3D speech gateway.

One small, OpenAI-compatible speech surface for the Office3D server:

- ``GET  /v1/voices``               the voices the office may use;
- ``POST /v1/audio/speech``         text to speech;
- ``POST /v1/audio/transcriptions`` speech to text (multipart);
- ``GET  /health``                  readiness of each engine.

Voices are named ``<engine>:<name>``. ``silero:<speaker>`` is served here, by
Silero TTS v5 with silero-stress placing Russian word stress; everything named
``voicestudio:<voice>`` is forwarded to a VoiceStudio backend. Speech is
recognised here too, by GigaAM v3 (onnx-asr, CPU) with Silero VAD; VoiceStudio's
Whisper is the fallback. All engines are open source and run locally; no paid
API is used.

MIT licensed (part of Office3D). VoiceStudio (AGPL-3.0) runs as a separate
process and is only spoken to over HTTP.
"""

__version__ = "1.1.0"
