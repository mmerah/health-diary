"""SQLite storage. All data lives in one file: $DATA_DIR/diary.db.

Every row belongs to one user. Diary entries, health data, profile and settings
are stored as JSON, so the front end can add fields without a migration.
"""
import json
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
DB_PATH = DATA_DIR / "diary.db"
SCHEMA_VERSION = 2

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  username          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash     TEXT NOT NULL,
  is_admin          INTEGER NOT NULL DEFAULT 0,
  ingest_token_hash TEXT UNIQUE,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS kv (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key     TEXT NOT NULL,
  value   TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE TABLE IF NOT EXISTS days (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  log        TEXT,
  health     TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, date)
);
CREATE TABLE IF NOT EXISTS measurements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  date        TEXT NOT NULL,
  time        TEXT,
  value       TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'manual',
  external_id TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_measurements_user_date ON measurements(user_id, date);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
"""

LEGACY_TABLES = ("kv", "days", "measurements")


@contextmanager
def connect():
    db = sqlite3.connect(DB_PATH, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA foreign_keys=ON")
    try:
        yield db
        db.commit()
    finally:
        db.close()


def init():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with connect() as db:
        if db.execute("PRAGMA user_version").fetchone()[0] < SCHEMA_VERSION:
            # Version 1 had no users. Keep its tables aside; the first account takes them over.
            for t in LEGACY_TABLES:
                exists = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (t,)).fetchone()
                if exists and "user_id" not in [c["name"] for c in db.execute(f"PRAGMA table_info({t})")]:
                    db.execute(f"ALTER TABLE {t} RENAME TO legacy_{t}")
        db.executescript(SCHEMA)
        db.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")


def _adopt_legacy(db, uid):
    """Moves version 1 data (single user, no accounts) to the given user."""
    names = {r["name"] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if "legacy_kv" in names:
        db.execute("INSERT OR IGNORE INTO kv (user_id, key, value) SELECT ?, key, value FROM legacy_kv", (uid,))
    if "legacy_days" in names:
        db.execute("INSERT OR IGNORE INTO days (user_id, date, log, health, updated_at) "
                   "SELECT ?, date, log, health, updated_at FROM legacy_days", (uid,))
    if "legacy_measurements" in names:
        db.execute("INSERT OR IGNORE INTO measurements (user_id, type, date, time, value, source, external_id, created_at) "
                   "SELECT ?, type, date, time, value, source, external_id, created_at FROM legacy_measurements", (uid,))
    for t in LEGACY_TABLES:
        db.execute(f"DROP TABLE IF EXISTS legacy_{t}")


def _load(s):
    return json.loads(s) if s else None


# ---------- Users and sessions

def _user(row):
    return {"id": row["id"], "username": row["username"], "isAdmin": bool(row["is_admin"]),
            "hasIngestToken": bool(row["ingest_token_hash"]), "createdAt": row["created_at"]}


def count_users():
    with connect() as db:
        return db.execute("SELECT COUNT(*) FROM users").fetchone()[0]


def create_user(username, password_hash, is_admin=False):
    with connect() as db:
        first = db.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0
        cur = db.execute("INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)",
                         (username, password_hash, 1 if is_admin else 0))
        if first:
            _adopt_legacy(db, cur.lastrowid)
        return _user(db.execute("SELECT * FROM users WHERE id = ?", (cur.lastrowid,)).fetchone())


def get_user(uid):
    with connect() as db:
        row = db.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
    return _user(row) if row else None


def get_user_login(username):
    """Returns (user, password_hash) or (None, None)."""
    with connect() as db:
        row = db.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    return (_user(row), row["password_hash"]) if row else (None, None)


def get_password_hash(uid):
    with connect() as db:
        return db.execute("SELECT password_hash FROM users WHERE id = ?", (uid,)).fetchone()[0]


def list_users():
    with connect() as db:
        return [_user(r) for r in db.execute("SELECT * FROM users ORDER BY id")]


def set_password(uid, password_hash):
    with connect() as db:
        db.execute("UPDATE users SET password_hash = ? WHERE id = ?", (password_hash, uid))


def set_admin(uid, is_admin):
    with connect() as db:
        db.execute("UPDATE users SET is_admin = ? WHERE id = ?", (1 if is_admin else 0, uid))


def count_admins():
    with connect() as db:
        return db.execute("SELECT COUNT(*) FROM users WHERE is_admin = 1").fetchone()[0]


def delete_user(uid):
    """Deletes the user and, through ON DELETE CASCADE, all their data and sessions."""
    with connect() as db:
        return db.execute("DELETE FROM users WHERE id = ?", (uid,)).rowcount


def set_ingest_token(uid, token_hash):
    with connect() as db:
        db.execute("UPDATE users SET ingest_token_hash = ? WHERE id = ?", (token_hash, uid))


def user_by_ingest_token(token_hash):
    with connect() as db:
        row = db.execute("SELECT * FROM users WHERE ingest_token_hash = ?", (token_hash,)).fetchone()
    return _user(row) if row else None


def create_session(token_hash, uid, expires_at):
    with connect() as db:
        db.execute("DELETE FROM sessions WHERE expires_at < datetime('now')")
        db.execute("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)", (token_hash, uid, expires_at))


def get_session(token_hash):
    """Returns (user, expires_at) for a valid session, else (None, None)."""
    with connect() as db:
        row = db.execute("""SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
                            WHERE s.token_hash = ? AND s.expires_at > datetime('now')""", (token_hash,)).fetchone()
    return (_user(row), row["expires_at"]) if row else (None, None)


def extend_session(token_hash, expires_at):
    with connect() as db:
        db.execute("UPDATE sessions SET expires_at = ? WHERE token_hash = ?", (expires_at, token_hash))


def delete_session(token_hash):
    with connect() as db:
        db.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))


def delete_sessions(uid, keep=None):
    """Logs the user out everywhere, except the session `keep`."""
    with connect() as db:
        db.execute("DELETE FROM sessions WHERE user_id = ? AND token_hash IS NOT ?", (uid, keep))


# ---------- Key/value (profile, settings, Paperless)

def get_kv(uid, key, default):
    with connect() as db:
        row = db.execute("SELECT value FROM kv WHERE user_id = ? AND key = ?", (uid, key)).fetchone()
    return _load(row["value"]) if row else default


def set_kv(uid, key, value):
    with connect() as db:
        db.execute("""INSERT INTO kv (user_id, key, value) VALUES (?, ?, ?)
                      ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value""", (uid, key, json.dumps(value)))


# ---------- Days

def get_day(uid, date):
    with connect() as db:
        row = db.execute("SELECT log, health FROM days WHERE user_id = ? AND date = ?", (uid, date)).fetchone()
    return {"date": date, "log": _load(row["log"]) if row else None, "health": _load(row["health"]) if row else None}


def list_days(uid, date_from=None, date_to=None):
    sql, args = "SELECT date, log, health FROM days WHERE user_id = ?", [uid]
    if date_from:
        sql += " AND date >= ?"
        args.append(date_from)
    if date_to:
        sql += " AND date <= ?"
        args.append(date_to)
    with connect() as db:
        rows = db.execute(sql + " ORDER BY date", args).fetchall()
    return [{"date": r["date"], "log": _load(r["log"]), "health": _load(r["health"])} for r in rows]


def save_day_part(uid, date, part, value):
    assert part in ("log", "health")
    with connect() as db:
        db.execute(f"""INSERT INTO days (user_id, date, {part}) VALUES (?, ?, ?)
                       ON CONFLICT(user_id, date) DO UPDATE SET {part} = excluded.{part}, updated_at = datetime('now')""",
                   (uid, date, json.dumps(value)))


# ---------- Measurements

def _m(row):
    return {"id": row["id"], "type": row["type"], "date": row["date"], "time": row["time"],
            "value": json.loads(row["value"]), "source": row["source"]}


def list_measurements(uid, mtype=None):
    sql, args = "SELECT * FROM measurements WHERE user_id = ?", [uid]
    if mtype:
        sql += " AND type = ?"
        args.append(mtype)
    with connect() as db:
        rows = db.execute(sql + " ORDER BY date, COALESCE(time, '')", args).fetchall()
    return [_m(r) for r in rows]


def add_measurement(uid, mtype, date, time, value, source="manual", external_id=None):
    """Adds a measurement. With an external_id, a second import of the same value is ignored."""
    with connect() as db:
        cur = db.execute("""INSERT OR IGNORE INTO measurements (user_id, type, date, time, value, source, external_id)
                            VALUES (?, ?, ?, ?, ?, ?, ?)""", (uid, mtype, date, time, json.dumps(value), source, external_id))
        if cur.rowcount == 0:
            return None
        row = db.execute("SELECT * FROM measurements WHERE id = ?", (cur.lastrowid,)).fetchone()
    return _m(row)


def delete_measurement(uid, mid):
    with connect() as db:
        return db.execute("DELETE FROM measurements WHERE id = ? AND user_id = ?", (mid, uid)).rowcount
