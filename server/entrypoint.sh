#!/bin/sh
# Starts as root only to give the data folder to PUID:PGID, then runs the app as that user.
set -e
# New files (database, key, uploads) are readable by the app user only.
umask 077
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  # Change only what has another owner or is open to others. No blind chown -R:
  # it is slow on a large folder, and it would touch files that are already right.
  find "$DATA_DIR" \( ! -user "$PUID" -o ! -group "$PGID" \) -exec chown -h "$PUID:$PGID" {} +
  find "$DATA_DIR" -perm /077 ! -type l -exec chmod go-rwx {} +
  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups -- "$@"
fi
chmod 700 "$DATA_DIR" 2>/dev/null || true
exec "$@"
