"""Run before the server (entrypoint.sh): `python -m app.preflight`.

Stops the start with a plain message, as the last line of the log, when the data folder cannot
be used. Without it, the server would fail at start, then Docker would restart it again and again.
"""
import sys

from . import db


def main():
    try:
        db.check_version()
    except db.DataFolderError as e:
        print(f"ERROR: {e}", file=sys.stderr, flush=True)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
