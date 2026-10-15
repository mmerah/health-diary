"""SQLite storage. All data lives in one file: $DATA_DIR/diary.db.

Every row belongs to one user. Diary entries, health data, profile and settings
are stored as JSON, so the front end can add fields without a migration.

Connections run in autocommit mode. `transaction()` groups several statements
(BEGIN IMMEDIATE ... COMMIT); every db function called inside it joins it.
"""
import json
import logging
import os
import shutil
import sqlite3
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path

log = logging.getLogger("uvicorn.error")

DATA_DIR = DB_PATH = TMP_DIR = None


def configure(data_dir):
    """Sets where the data lives. Called at import, and by the tests for a fresh folder."""
    global DATA_DIR, DB_PATH, TMP_DIR
    DATA_DIR = Path(data_dir)
    DB_PATH = DATA_DIR / "diary.db"
    TMP_DIR = DATA_DIR / "tmp"  # uploads; on the data volume, not in the container's memory


configure(os.environ.get("DATA_DIR", "/data"))

_active = ContextVar("db_transaction", default=None)


def room():
    """Bytes that uploads may still use: the free space of the data disk, minus a reserve of
    1 GB or 10% of the disk (the larger). The database must never fill the disk."""
    usage = shutil.disk_usage(DATA_DIR)
    return usage.free - max(1024 ** 3, usage.total // 10)


def _open():
    con = sqlite3.connect(DB_PATH, timeout=10, isolation_level=None)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    # Deleted rows are overwritten with zeros, so a deleted diary does not stay in free pages.
    con.execute("PRAGMA secure_delete=ON")
    return con


@contextmanager
def connect():
    con = _active.get()
    if con is not None:  # inside transaction(): use its connection
        yield con
        return
    con = _open()
    try:
        yield con
    finally:
        con.close()


@contextmanager
def transaction():
    """All statements in the block are written together, or not at all."""
    if _active.get() is not None:
        yield _active.get()
        return
    con = _open()
    token = _active.set(con)
    try:
        con.execute("BEGIN IMMEDIATE")
        yield con
        con.execute("COMMIT")
    except BaseException:
        if con.in_transaction:
            con.execute("ROLLBACK")
        raise
    finally:
        _active.reset(token)
        con.close()


# ---------- Schema and migrations

# Version 1, the schema of the first release. Never edit it after a release: add a migration.
SCHEMA = [
    """CREATE TABLE users (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      username          TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash     TEXT NOT NULL,
      is_admin          INTEGER NOT NULL DEFAULT 0,
      ingest_token_hash TEXT UNIQUE,
      ingest_last_used  TEXT,
      notice            TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')))""",
    """CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))""",
    # Profile, settings, catalog, Paperless settings. Each save of a value adds 1 to its version:
    # a device sends the version it started from, and the server refuses a lost update.
    """CREATE TABLE kv (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key     TEXT NOT NULL,
      value   TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (user_id, key))""",
    # log_version works like kv.version, for the day log only (sync and import write health).
    """CREATE TABLE days (
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date        TEXT NOT NULL,
      log         TEXT,
      health      TEXT,
      log_version INTEGER NOT NULL DEFAULT 0,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, date))""",
    """CREATE TABLE measurements (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type        TEXT NOT NULL,
      date        TEXT NOT NULL,
      time        TEXT,
      value       TEXT NOT NULL,
      source      TEXT NOT NULL DEFAULT 'manual',
      external_id TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, external_id))""",
    # Documents kept in the diary (without Paperless). The file is on disk, encrypted (documents.py).
    # content and suggested hold health data, so they are encrypted too. Title, date and category
    # stay plain: the list needs them.
    """CREATE TABLE documents (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL,
      date        TEXT NOT NULL,
      title       TEXT NOT NULL,
      category    TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'processing',
      error       TEXT,
      pages       INTEGER,
      size        INTEGER NOT NULL,
      content     TEXT,
      suggested   TEXT,
      edited      TEXT NOT NULL DEFAULT '[]',
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))""",
    "CREATE INDEX idx_measurements_user_date ON measurements(user_id, date)",
    "CREATE INDEX idx_sessions_user ON sessions(user_id)",
    "CREATE INDEX idx_documents_user ON documents(user_id, date)",
]

# Changes after the first release, in order: (version, function(connection)). Each step runs in
# its own transaction and sets user_version to its number. Add steps from here on (2, 3, ...).
MIGRATIONS = []
SCHEMA_VERSION = MIGRATIONS[-1][0] if MIGRATIONS else 1


def init():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    TMP_DIR.mkdir(mode=0o700, exist_ok=True)
    for p in (DATA_DIR, TMP_DIR):
        try:
            p.chmod(0o700)
        except OSError:
            log.warning("Cannot set the permissions of %s to 700.", p)
    for f in TMP_DIR.iterdir():  # uploads left by a crash
        f.unlink(missing_ok=True)
    with connect() as c:
        c.execute("PRAGMA journal_mode=WAL")  # stored in the file; set once
    with transaction() as c:
        if c.execute("PRAGMA user_version").fetchone()[0] == 0:  # a new database
            for statement in SCHEMA:
                c.execute(statement)
            c.execute("PRAGMA user_version = 1")
    for version, step in MIGRATIONS:
        with transaction() as c:
            if c.execute("PRAGMA user_version").fetchone()[0] < version:
                step(c)
                c.execute(f"PRAGMA user_version = {version}")
    if DB_PATH.exists():
        DB_PATH.chmod(0o600)


def _load(s):
    return json.loads(s) if s else None


def scrub():
    """After a delete: write the WAL into the main file and empty it, so deleted data does not stay in the WAL."""
    with connect() as c:
        c.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        size = c.execute("PRAGMA page_count").fetchone()[0] * c.execute("PRAGMA page_size").fetchone()[0]
        if size < 64 * 1024 * 1024:  # VACUUM rewrites the file; only when that is quick
            c.execute("VACUUM")
            c.execute("PRAGMA wal_checkpoint(TRUNCATE)")


# ---------- Users and sessions

class LastAdmin(Exception):
    """The change would leave the install without an administrator."""


class Conflict(Exception):
    """Another device saved first. Holds what is stored now."""

    def __init__(self, value, version):
        super().__init__("version conflict")
        self.value, self.version = value, version


def _user(row):
    return {"id": row["id"], "username": row["username"], "isAdmin": bool(row["is_admin"]),
            "hasIngestToken": bool(row["ingest_token_hash"]), "ingestLastUsed": row["ingest_last_used"],
            "createdAt": row["created_at"], "notice": row["notice"]}


def count_users():
    with connect() as c:
        return c.execute("SELECT COUNT(*) FROM users").fetchone()[0]


def create_user(username, password_hash, is_admin=False, only_if_empty=False):
    """Returns the new user. Returns None if only_if_empty and an account exists.
    Raises sqlite3.IntegrityError if the username is taken."""
    with transaction() as c:
        if only_if_empty and c.execute("SELECT COUNT(*) FROM users").fetchone()[0]:
            return None
        uid = c.execute("INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)",
                        (username, password_hash, 1 if is_admin else 0)).lastrowid
        return _user(c.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone())


def get_user(uid):
    with connect() as c:
        row = c.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
    return _user(row) if row else None


def get_user_login(username):
    """Returns (user, password_hash) or (None, None)."""
    with connect() as c:
        row = c.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    return (_user(row), row["password_hash"]) if row else (None, None)


def get_password_hash(uid):
    with connect() as c:
        return c.execute("SELECT password_hash FROM users WHERE id = ?", (uid,)).fetchone()[0]


def list_users():
    with connect() as c:
        return [_user(r) for r in c.execute("SELECT * FROM users ORDER BY id")]


def set_password(uid, password_hash, notice=None):
    """notice: a message the user sees at the next login (for example after an administrator reset)."""
    with connect() as c:
        c.execute("UPDATE users SET password_hash = ?, notice = ? WHERE id = ?", (password_hash, notice, uid))


def clear_notice(uid):
    with connect() as c:
        c.execute("UPDATE users SET notice = NULL WHERE id = ?", (uid,))


def _guard_last_admin(c, uid, allow_sole_user=False):
    row = c.execute("SELECT is_admin FROM users WHERE id = ?", (uid,)).fetchone()
    if not row or not row["is_admin"]:
        return
    admins = c.execute("SELECT COUNT(*) FROM users WHERE is_admin = 1").fetchone()[0]
    users = c.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    if admins == 1 and not (allow_sole_user and users == 1):
        raise LastAdmin()


def set_admin(uid, is_admin):
    """Returns False if the user does not exist. Raises LastAdmin."""
    with transaction() as c:
        if not c.execute("SELECT 1 FROM users WHERE id = ?", (uid,)).fetchone():
            return False
        if not is_admin:
            _guard_last_admin(c, uid)
        c.execute("UPDATE users SET is_admin = ? WHERE id = ?", (1 if is_admin else 0, uid))
        return True


def delete_user(uid, allow_sole_user=False):
    """Deletes the user and, through ON DELETE CASCADE, all their data and sessions.
    Returns False if the user does not exist. Raises LastAdmin."""
    with transaction() as c:
        _guard_last_admin(c, uid, allow_sole_user)
        deleted = c.execute("DELETE FROM users WHERE id = ?", (uid,)).rowcount
    if deleted:
        scrub()
    return bool(deleted)


def set_ingest_token(uid, token_hash):
    with connect() as c:
        c.execute("UPDATE users SET ingest_token_hash = ?, ingest_last_used = NULL WHERE id = ?", (token_hash, uid))


def touch_ingest(uid):
    with connect() as c:
        c.execute("UPDATE users SET ingest_last_used = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?", (uid,))


def user_by_ingest_token(token_hash):
    with connect() as c:
        row = c.execute("SELECT * FROM users WHERE ingest_token_hash = ?", (token_hash,)).fetchone()
    return _user(row) if row else None


def purge_sessions():
    with connect() as c:
        return c.execute("DELETE FROM sessions WHERE expires_at < datetime('now')").rowcount


def create_session(token_hash, uid, expires_at):
    with connect() as c:
        c.execute("DELETE FROM sessions WHERE expires_at < datetime('now')")
        c.execute("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)", (token_hash, uid, expires_at))


def get_session(token_hash):
    """Returns (user, expires_at) for a valid session, else (None, None)."""
    with connect() as c:
        row = c.execute("""SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
                           WHERE s.token_hash = ? AND s.expires_at > datetime('now')""", (token_hash,)).fetchone()
    return (_user(row), row["expires_at"]) if row else (None, None)


def extend_session(token_hash, expires_at):
    with connect() as c:
        c.execute("UPDATE sessions SET expires_at = ? WHERE token_hash = ?", (expires_at, token_hash))


def delete_session(token_hash):
    with connect() as c:
        c.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))


def delete_sessions(uid, keep=None):
    """Logs the user out everywhere, except the session `keep`."""
    with connect() as c:
        c.execute("DELETE FROM sessions WHERE user_id = ? AND token_hash IS NOT ?", (uid, keep))


# ---------- Key/value (profile, settings, Paperless)

def get_kv(uid, key, default):
    return get_kv_version(uid, key, default)[0]


def get_kv_version(uid, key, default):
    """Returns (value, version). Version 0: never saved."""
    with connect() as c:
        row = c.execute("SELECT value, version FROM kv WHERE user_id = ? AND key = ?", (uid, key)).fetchone()
    return (_load(row["value"]), row["version"]) if row else (default, 0)


def set_kv(uid, key, value, base=None):
    """Saves and returns the new version. With `base`, refuses (Conflict) if the stored version differs."""
    with transaction() as c:
        if base is not None:
            current, version = get_kv_version(uid, key, None)
            if version != base:
                raise Conflict(current, version)
        c.execute("""INSERT INTO kv (user_id, key, value, version) VALUES (?, ?, ?, 1)
                     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, version = version + 1""",
                  (uid, key, json.dumps(value)))
        return c.execute("SELECT version FROM kv WHERE user_id = ? AND key = ?", (uid, key)).fetchone()[0]


def update_kv(uid, key, changes):
    """Merges `changes` into a JSON object, in one transaction. Returns the result."""
    with transaction():
        value = {**get_kv(uid, key, {}), **changes}
        set_kv(uid, key, value)
    return value


def all_kv(key):
    """(user_id, value) for every user that has `key`."""
    with connect() as c:
        return [(r["user_id"], _load(r["value"])) for r in c.execute("SELECT user_id, value FROM kv WHERE key = ?", (key,))]


# ---------- Days

def _day(r):
    return {"date": r["date"], "log": _load(r["log"]), "health": _load(r["health"]), "logVersion": r["log_version"]}


def get_day(uid, date):
    with connect() as c:
        row = c.execute("SELECT date, log, health, log_version FROM days WHERE user_id = ? AND date = ?",
                        (uid, date)).fetchone()
    return _day(row) if row else {"date": date, "log": None, "health": None, "logVersion": 0}


def list_days(uid, date_from=None, date_to=None):
    sql, args = "SELECT date, log, health, log_version FROM days WHERE user_id = ?", [uid]
    if date_from:
        sql += " AND date >= ?"
        args.append(date_from)
    if date_to:
        sql += " AND date <= ?"
        args.append(date_to)
    with connect() as c:
        return [_day(r) for r in c.execute(sql + " ORDER BY date", args)]


def save_log(uid, date, log, base=None):
    """Saves a day log and returns its new version. With `base`, refuses (Conflict) if the stored
    version differs. Health data (sync, import) has no version: it never conflicts with the log."""
    with transaction() as c:
        day = get_day(uid, date)
        if base is not None and base != day["logVersion"]:
            raise Conflict(day["log"], day["logVersion"])
        c.execute("""INSERT INTO days (user_id, date, log, log_version) VALUES (?, ?, ?, 1)
                     ON CONFLICT(user_id, date) DO UPDATE SET log = excluded.log, log_version = log_version + 1,
                     updated_at = datetime('now')""", (uid, date, json.dumps(log)))
        return day["logVersion"] + 1


def save_day_part(uid, date, part, value):
    save_days_part(uid, part, [(date, value)])


def save_days_part(uid, part, rows):
    """rows: [(date, value)]. One statement for many days (the history import). Not for logs: see save_log."""
    assert part == "health"
    with connect() as c:
        c.executemany(f"""INSERT INTO days (user_id, date, {part}) VALUES (?, ?, ?)
                          ON CONFLICT(user_id, date) DO UPDATE SET {part} = excluded.{part}, updated_at = datetime('now')""",
                      [(uid, d, json.dumps(v)) for d, v in rows])


# ---------- Measurements

def _m(row):
    return {"id": row["id"], "type": row["type"], "date": row["date"], "time": row["time"],
            "value": json.loads(row["value"]), "source": row["source"]}


def list_measurements(uid, mtype=None, date_from=None, date_to=None):
    sql, args = "SELECT * FROM measurements WHERE user_id = ?", [uid]
    for clause, arg in (("type = ?", mtype), ("date >= ?", date_from), ("date <= ?", date_to)):
        if arg:
            sql += " AND " + clause
            args.append(arg)
    with connect() as c:
        return [_m(r) for r in c.execute(sql + " ORDER BY date, COALESCE(time, '')", args)]


def add_measurement(uid, mtype, date, time, value, source="manual", external_id=None):
    """Adds a measurement. With an external_id, a second import of the same value is ignored."""
    with connect() as c:
        cur = c.execute("""INSERT OR IGNORE INTO measurements (user_id, type, date, time, value, source, external_id)
                           VALUES (?, ?, ?, ?, ?, ?, ?)""", (uid, mtype, date, time, json.dumps(value), source, external_id))
        if cur.rowcount == 0:
            return None
        return _m(c.execute("SELECT * FROM measurements WHERE id = ?", (cur.lastrowid,)).fetchone())


def add_measurements(uid, rows):
    """rows: [(type, date, time, value, source, external_id)]. Returns how many were new."""
    with connect() as c:
        return c.executemany("""INSERT OR IGNORE INTO measurements (user_id, type, date, time, value, source, external_id)
                                VALUES (?, ?, ?, ?, ?, ?, ?)""",
                             [(uid, t, d, tm, json.dumps(v), s, x) for t, d, tm, v, s, x in rows]).rowcount


# ---------- Documents (rows only: documents.py handles files, encryption and text)

def _doc(row):
    return dict(row) if row else None


def add_document(uid, kind, date, title, category, pages, size, edited=()):
    with connect() as c:
        cur = c.execute("""INSERT INTO documents (user_id, kind, date, title, category, pages, size, edited)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                        (uid, kind, date, title, category, pages, size, json.dumps(sorted(edited))))
        return _doc(c.execute("SELECT * FROM documents WHERE id = ?", (cur.lastrowid,)).fetchone())


def get_document(uid, doc_id):
    """uid None: any user (the background worker)."""
    with connect() as c:
        if uid is None:
            return _doc(c.execute("SELECT * FROM documents WHERE id = ?", (doc_id,)).fetchone())
        return _doc(c.execute("SELECT * FROM documents WHERE id = ? AND user_id = ?", (doc_id, uid)).fetchone())


def list_documents(uid):
    with connect() as c:
        return [_doc(r) for r in c.execute("SELECT * FROM documents WHERE user_id = ? ORDER BY date DESC, id DESC", (uid,))]


def processing_documents():
    with connect() as c:
        return [r[0] for r in c.execute("SELECT id FROM documents WHERE status = 'processing' ORDER BY id")]


def update_document(doc_id, **fields):
    """Changes the given columns. Returns False if the document is gone."""
    assert set(fields) <= {"date", "title", "category", "status", "error", "pages", "content", "suggested", "edited"}
    sets = ", ".join(f"{k} = ?" for k in fields)
    with connect() as c:
        return c.execute(f"UPDATE documents SET {sets} WHERE id = ?", (*fields.values(), doc_id)).rowcount > 0


def delete_document(uid, doc_id):
    with connect() as c:
        return c.execute("DELETE FROM documents WHERE id = ? AND user_id = ?", (doc_id, uid)).rowcount


def delete_measurement(uid, mid):
    with connect() as c:
        return c.execute("DELETE FROM measurements WHERE id = ? AND user_id = ?", (mid, uid)).rowcount
