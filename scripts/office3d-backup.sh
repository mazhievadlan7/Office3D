#!/usr/bin/env sh
# Office3D backups, from the server (run in the directory with docker-compose.yml).
#
#   scripts/office3d-backup.sh list             the backups and the schedule
#   scripts/office3d-backup.sh now              take one now
#   scripts/office3d-backup.sh restore <id>     go back to one (asks first)
#
# Backups are in the hermes-backups volume, under daily/<id>/. See
# docs/deployment.md for copying them off the server.
set -eu
cd "$(dirname "$0")/.."

run() {
  docker compose exec -T updater node server/updater/cli.js "$@"
}

case "${1:-}" in
  list | now)
    run "$1"
    ;;
  restore)
    id="${2:-}"
    if [ -z "$id" ]; then
      echo "Which backup? scripts/office3d-backup.sh list shows them." >&2
      exit 2
    fi
    echo "This stops the office and Hermes, replaces all their data with backup $id"
    echo "and starts them again. The current state is backed up first (label pre-restore)."
    printf 'Type the backup id to confirm: '
    read -r answer
    if [ "$answer" != "$id" ]; then
      echo "Not confirmed; nothing changed." >&2
      exit 1
    fi
    run restore "$id"
    ;;
  *)
    sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
