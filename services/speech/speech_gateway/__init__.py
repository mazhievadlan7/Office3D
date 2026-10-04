"""Office3D speech gateway.

One small, OpenAI-compatible speech surface for the Office3D server:

- ``GET  /v1/voices``               the voices the office may use;
- ``POST /v1/audio/speech``         text to speech;
- ``POST /v1/audio/transcriptions`` speech to text (multipart);
- ``GET  /health``                  readiness of each engine.

Voices are named ``silero:<name>`` and spoken here by Silero TTS v5 on the
CPU, with silero-stress placing Russian word stress and each voice's own
post-processing (fx.py). Speech is recognised here too, by GigaAM v3
(onnx-asr, CPU) with Silero VAD. Nothing uses the GPU: it stays free for the
HQ's 3D. All engines are open source and run locally; no paid API is used.

MIT licensed (part of Office3D).
"""

__version__ = "1.2.0"
