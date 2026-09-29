#!/usr/bin/env bash
# Installs Office3D's speech engines outside the repository (Linux, macOS).
#
#   - the speech gateway (services/speech): a Python venv with Silero TTS v5
#     and silero-stress, plus their model weights;
#   - VoiceStudio's backend (headless, no desktop app): cloned, its own venv
#     via uv, the VoxCPM2 engine in VoiceStudio's sidecar venv, and the
#     Whisper weights for speech recognition.
#
# Everything lands in $OFFICE3D_SPEECH_HOME (default
# ${XDG_DATA_HOME:-~/.local/share}/office3d-speech). Nothing is written into the
# repository. Idempotent: run it again to update. Start with `npm run speech`,
# or install the systemd units from docs/deployment.md on a server.
#
# Needs: python3 (3.11+), git, uv (https://docs.astral.sh/uv/). NVIDIA GPU is
# optional (CUDA 12.8 wheels); without one everything runs on the CPU.
#
# Options (environment):
#   OFFICE3D_SPEECH_HOME   install location
#   SPEECH_TORCH           auto | cpu | cu128        (default auto)
#   SPEECH_PYTHON          python interpreter        (default python3)
#   VOICESTUDIO_REF        git tag/branch            (default v0.5.6)
#   SKIP_VOICESTUDIO=1     gateway + Silero only (CPU-only servers can start here)
#   SKIP_VOXCPM2=1         VoiceStudio without the VoxCPM2 engine (CPU-only servers)
#   ASR_MODEL              Whisper weights (default Systran/faster-whisper-large-v3;
#                          Systran/faster-whisper-medium or -small are lighter on a CPU)
#   SKIP_ASR=1             no speech-recognition model
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_DIR="$REPO_ROOT/services/speech"
SPEECH_HOME="${OFFICE3D_SPEECH_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/office3d-speech}"
TORCH="${SPEECH_TORCH:-auto}"
PYTHON="${SPEECH_PYTHON:-python3}"
VOICESTUDIO_REPO="${VOICESTUDIO_REPO:-https://github.com/debpalash/VoiceStudio.git}"
VOICESTUDIO_REF="${VOICESTUDIO_REF:-v0.5.6}"

step() { printf '\033[36m==> %s\033[0m\n' "$*"; }
fail() { printf '\033[31merror: %s\033[0m\n' "$*" >&2; exit 1; }

mkdir -p "$SPEECH_HOME"
SPEECH_HOME="$(cd "$SPEECH_HOME" && pwd)"
case "$SPEECH_HOME/" in "$REPO_ROOT"/*) fail "OFFICE3D_SPEECH_HOME must be outside the repository ($SPEECH_HOME)." ;; esac
step "Speech home: $SPEECH_HOME"

command -v "$PYTHON" >/dev/null || fail "$PYTHON not found (Python 3.11+ is needed)."
"$PYTHON" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' || fail "Python 3.11+ is needed."
PYTHON="$(command -v "$PYTHON")"
command -v uv >/dev/null || fail "uv not found. Install it: curl -LsSf https://astral.sh/uv/install.sh | sh"
export UV_LINK_MODE=copy

if [ "$TORCH" = "auto" ]; then
  TORCH=cpu
  if command -v nvidia-smi >/dev/null && nvidia-smi -L >/dev/null 2>&1; then TORCH=cu128; fi
fi
step "Torch build: $TORCH"

# --- speech gateway -----------------------------------------------------------
GATEWAY_VENV="$SPEECH_HOME/gateway-venv"
GATEWAY_PYTHON="$GATEWAY_VENV/bin/python"
[ -x "$GATEWAY_PYTHON" ] || { step "Creating the gateway venv"; uv venv "$GATEWAY_VENV" --python "$PYTHON"; }
step "Installing the gateway's packages"
uv pip install --python "$GATEWAY_PYTHON" -r "$SERVICE_DIR/requirements-$TORCH.txt"
step "Downloading Silero and the stress model"
(cd "$SERVICE_DIR" && OFFICE3D_SPEECH_HOME="$SPEECH_HOME" "$GATEWAY_PYTHON" -m speech_gateway.tools prefetch)

# --- VoiceStudio ----------------------------------------------------------------
if [ "${SKIP_VOICESTUDIO:-}" = "1" ]; then step "Skipping VoiceStudio"; exit 0; fi
command -v git >/dev/null || fail "git not found."

VS_DIR="$SPEECH_HOME/voicestudio"
if [ ! -d "$VS_DIR/.git" ]; then
  step "Cloning VoiceStudio ($VOICESTUDIO_REF)"
  git clone --depth 1 --branch "$VOICESTUDIO_REF" "$VOICESTUDIO_REPO" "$VS_DIR"
else
  step "Updating VoiceStudio to $VOICESTUDIO_REF"
  git -C "$VS_DIR" fetch --depth 1 origin "$VOICESTUDIO_REF"
  git -C "$VS_DIR" checkout --detach FETCH_HEAD
fi

step "Installing VoiceStudio's backend (uv sync; several GB on the first run)"
(cd "$VS_DIR" && uv sync --no-dev --python "$PYTHON" && PYTHONIOENCODING=utf-8 .venv/bin/python scripts/setup.py)

VS_DATA="$SPEECH_HOME/voicestudio-data"
HF_DIR="$SPEECH_HOME/hf"
mkdir -p "$VS_DATA" "$HF_DIR" "$SPEECH_HOME/logs"

if [ "${SKIP_VOXCPM2:-}" = "1" ] && [ "${SKIP_ASR:-}" = "1" ]; then step "Skipping VoxCPM2 and the Whisper weights"; exit 0; fi

step "Starting VoiceStudio once to install its engine and models"
LOG="$SPEECH_HOME/logs/voicestudio-setup.log"
(cd "$VS_DIR" && OMNIVOICE_DATA_DIR="$VS_DATA" HF_HOME="$HF_DIR" OMNIVOICE_BIND_HOST=127.0.0.1 OMNIVOICE_PORT=3900 \
  exec .venv/bin/python backend/main.py) >"$LOG" 2>&1 &
VS_PID=$!
trap 'kill "$VS_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 120); do
  sleep 3
  if curl -fsS http://127.0.0.1:3900/health 2>/dev/null | grep -q '"status":"ok"'; then READY=1; break; fi
done
[ "${READY:-}" = "1" ] || fail "VoiceStudio did not start; see $LOG"
if [ "${SKIP_VOXCPM2:-}" != "1" ]; then
  step "Installing VoxCPM2 (its own sidecar venv)"
  (cd "$SERVICE_DIR" && "$GATEWAY_PYTHON" -m speech_gateway.tools voicestudio-install voxcpm2)
  step "Downloading VoxCPM2's weights (about 5 GB)"
  (cd "$SERVICE_DIR" && "$GATEWAY_PYTHON" -m speech_gateway.tools voicestudio-warm voxcpm2)
fi
if [ "${SKIP_ASR:-}" != "1" ]; then
  step "Downloading the speech-recognition model ${ASR_MODEL:-Systran/faster-whisper-large-v3}"
  (cd "$SERVICE_DIR" && "$GATEWAY_PYTHON" -m speech_gateway.tools voicestudio-model "${ASR_MODEL:-Systran/faster-whisper-large-v3}")
fi

step "Done. Start the speech services with: npm run speech"
[ -z "${OFFICE3D_SPEECH_HOME:-}" ] || echo "Keep OFFICE3D_SPEECH_HOME=$SPEECH_HOME in .env"
