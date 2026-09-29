# Office3D speech gateway — CPU image (Silero runs faster than real time on a
# few cores). VoiceStudio is a separate service; see docker-compose.yml.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    OFFICE3D_SPEECH_HOME=/data

RUN apt-get update \
    && apt-get install -y --no-install-recommends libsndfile1 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 speech \
    && mkdir -p /data && chown speech:speech /data

WORKDIR /app
COPY requirements.txt requirements-cpu.txt ./
RUN pip install -r requirements-cpu.txt

COPY speech_gateway ./speech_gateway
COPY voices.json lexicon.json stress.json ./
COPY voice-refs ./voice-refs

USER speech
EXPOSE 8765
CMD ["python", "-m", "speech_gateway"]
