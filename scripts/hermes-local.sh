#!/usr/bin/env bash
# hermes-local — run Office3D with a local Hermes Agent, without Docker.
#
#   npm run hermes-local
#
# Starts, in this order, and stops them all on Ctrl+C:
#   1. the Hermes gateway (API server on 127.0.0.1:8642, one listener for
#      every profile = office agent),
#   2. the Hermes dashboard on 127.0.0.1:9119 (profiles, kanban),
#   3. the Office3D dev server on :3000, pointed at both.
#
# Needs `hermes` on PATH (https://github.com/NousResearch/hermes-agent) with a
# model configured (`hermes setup`), and in Office3D's .env:
#   HERMES_API_KEY              the API_SERVER_KEY Hermes runs with (16+ chars)
#   HERMES_DASHBOARD_TOKEN      dashboard session token (16+ chars)
#   OFFICE3D_HERMES_KEY_SECRET  32+ chars; agent profile keys derive from it
# Generate each with: openssl rand -hex 32
#
# Ports already in use are an error rather than something to route around: a
# second Hermes on the same HERMES_HOME would corrupt its memory stores.

set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
LOG_DIR="${OFFICE3D_LOG_DIR:-${TMPDIR:-/tmp}/office3d-logs}"
mkdir -p "$LOG_DIR"

say() { printf '\033[0;32m[office3d]\033[0m %s\n' "$*"; }
die() { printf '\033[0;31m[office3d]\033[0m %s\n' "$*" >&2; exit 1; }

if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi

command -v hermes >/dev/null 2>&1 || die "hermes is not on PATH. Install Hermes Agent first."
command -v curl >/dev/null 2>&1 || die "curl is required."
[ "${#HERMES_API_KEY}" -ge 16 ] 2>/dev/null || die "Set HERMES_API_KEY (16+ characters) in .env."
[ "${#HERMES_DASHBOARD_TOKEN}" -ge 16 ] 2>/dev/null || die "Set HERMES_DASHBOARD_TOKEN (16+ characters) in .env."
[ "${#OFFICE3D_HERMES_KEY_SECRET}" -ge 32 ] 2>/dev/null || die "Set OFFICE3D_HERMES_KEY_SECRET (32+ characters) in .env."

port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
for port in 8642 9119 "${PORT:-3000}"; do
  port_busy "$port" && die "Port $port is already in use; stop whatever holds it first."
done

pids=()
cleanup() {
  for pid in "${pids[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

wait_for() {
  local url=$1 name=$2 tries=${3:-60}
  for _ in $(seq 1 "$tries"); do
    curl -sf -o /dev/null "$url" && return 0
    sleep 1
  done
  die "$name did not come up; see $LOG_DIR."
}

say "Starting the Hermes gateway (API on 127.0.0.1:8642)…"
API_SERVER_ENABLED=true API_SERVER_HOST=127.0.0.1 API_SERVER_PORT=8642 \
  API_SERVER_KEY="$HERMES_API_KEY" GATEWAY_MULTIPLEX_PROFILES=true \
  hermes gateway run >"$LOG_DIR/hermes-gateway.log" 2>&1 &
pids+=($!)
wait_for "http://127.0.0.1:8642/health" "The Hermes gateway"

say "Starting the Hermes dashboard (127.0.0.1:9119)…"
HERMES_DASHBOARD_SESSION_TOKEN="$HERMES_DASHBOARD_TOKEN" \
  hermes dashboard --host 127.0.0.1 --port 9119 --no-open >"$LOG_DIR/hermes-dashboard.log" 2>&1 &
pids+=($!)
# The first start may build the dashboard's web UI, which takes a while.
wait_for "http://127.0.0.1:9119/api/status" "The Hermes dashboard" 600

say "Starting Office3D…"
cd "$ROOT"
HERMES_API_URL=http://127.0.0.1:8642 HERMES_DASHBOARD_URL=http://127.0.0.1:9119 \
  npm run dev >"$LOG_DIR/office3d-dev.log" 2>&1 &
pids+=($!)
wait_for "http://127.0.0.1:${PORT:-3000}" "Office3D" 180

say "Office3D → http://127.0.0.1:${PORT:-3000}   (logs: $LOG_DIR)"
say "Ctrl+C stops everything."
wait
