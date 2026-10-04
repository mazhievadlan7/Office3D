#!/usr/bin/env bash
# Installs Office3D's speech gateway outside the repository (Linux, macOS).
#
#   The speech gateway (services/speech): a Python venv with Silero TTS v5 and
#   silero-stress (every voice: the system, AM7, the crew) and speech
#   recognition (GigaAM v3 + Silero VAD through onnx-asr), plus their model
#   weights. Everything runs on the CPU; no GPU is needed or used.
#
# Everything lands in $OFFICE3D_SPEECH_HOME (default
# ${XDG_DATA_HOME:-~/.local/share}/office3d-speech). Nothing is written into the
# repository. Idempotent: run it again to update. Start with `npm run speech`,
# or install the systemd unit from docs/deployment.md on a server.
#
# Needs: python3 (3.11+) and uv (https://docs.astral.sh/uv/).
#
# Options (environment):
#   OFFICE3D_SPEECH_HOME   install location
#   SPEECH_PYTHON          python interpreter        (default python3)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_DIR="$REPO_ROOT/services/speech"
SPEECH_HOME="${OFFICE3D_SPEECH_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/office3d-speech}"
PYTHON="${SPEECH_PYTHON:-python3}"

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

# --- speech gateway -----------------------------------------------------------
GATEWAY_VENV="$SPEECH_HOME/gateway-venv"
GATEWAY_PYTHON="$GATEWAY_VENV/bin/python"
[ -x "$GATEWAY_PYTHON" ] || { step "Creating the gateway venv"; uv venv "$GATEWAY_VENV" --python "$PYTHON"; }
step "Installing the gateway's packages (CPU torch)"
uv pip install --python "$GATEWAY_PYTHON" -r "$SERVICE_DIR/requirements-cpu.txt"
step "Downloading Silero, the stress model and GigaAM v3 (speech recognition, ~0.9 GB)"
(cd "$SERVICE_DIR" && OFFICE3D_SPEECH_HOME="$SPEECH_HOME" HF_HOME="$SPEECH_HOME/hf" \
  "$GATEWAY_PYTHON" -m speech_gateway.tools prefetch)

step "Done. Start the speech gateway with: npm run speech"
[ -z "${OFFICE3D_SPEECH_HOME:-}" ] || echo "Keep OFFICE3D_SPEECH_HOME=$SPEECH_HOME in .env"
