"""Encrypts secrets that the server must store and read back (Paperless tokens).

The key comes from $DIARY_SECRET_KEY. Without it, the server makes $DATA_DIR/secret.key
on the first start. A copy of the database alone then does not reveal the tokens,
as long as the key is kept apart from it.
"""
import base64
import hashlib
import logging
import os

from cryptography.fernet import Fernet, InvalidToken

from . import db

log = logging.getLogger("uvicorn.error")
PREFIX = "v1:"
_fernet = None


def init():
    global _fernet
    secret = os.environ.get("DIARY_SECRET_KEY", "").strip()
    if not secret:
        path = db.DATA_DIR / "secret.key"
        if not path.exists():
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as f:
                f.write(Fernet.generate_key().decode())
            log.warning("DIARY_SECRET_KEY is not set. A new key is in %s. Set DIARY_SECRET_KEY in .env "
                        "and keep a copy of it apart from your backups of the data folder.", path)
        secret = path.read_text().strip()
    # Any string works as the secret: it is turned into a Fernet key the same way each time.
    _fernet = Fernet(base64.urlsafe_b64encode(hashlib.sha256(secret.encode()).digest()))


def encrypt(text):
    return PREFIX + _fernet.encrypt(text.encode()).decode()


def decrypt(blob):
    """Returns the text, or None if the key changed or the value is damaged."""
    if not blob or not blob.startswith(PREFIX):
        return None
    try:
        return _fernet.decrypt(blob[len(PREFIX):].encode()).decode()
    except InvalidToken:
        log.warning("Cannot decrypt a stored secret. Was DIARY_SECRET_KEY changed?")
        return None
