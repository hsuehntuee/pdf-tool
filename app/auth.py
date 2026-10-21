"""Single-user auth: credentials live in .env (password stored as PBKDF2 hash)."""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = Path(os.environ.get("PDFTOOL_ENV", ROOT / ".env"))
ITER = 310_000


def hash_password(pw: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), ITER)
    return f"pbkdf2${ITER}${salt}${dk.hex()}"


def verify_password(pw: str, stored: str) -> bool:
    try:
        _, it, salt, digest = stored.split("$")
        dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), int(it))
        return hmac.compare_digest(dk.hex(), digest)
    except (ValueError, TypeError):
        return False


def read_env() -> dict[str, str]:
    env: dict[str, str] = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    env.update({k: v for k, v in os.environ.items() if k.startswith("PDFTOOL_")})
    return env


def write_env(values: dict[str, str]) -> None:
    current = {}
    if ENV_FILE.exists():
        current = {k: v for k, v in read_env().items() if k in _file_keys()}
    current.update(values)
    lines = ["# PDF Tool settings — keep this file private (it is git-ignored)"]
    lines += [f"{k}={v}" for k, v in current.items()]
    ENV_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _file_keys() -> set[str]:
    keys = set()
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            keys.add(line.split("=", 1)[0].strip())
    return keys


def ensure_config() -> tuple[dict[str, str], str | None]:
    """Create .env on first run. Returns (config, newly_generated_password_or_None)."""
    env = read_env()
    generated = None
    updates = {}
    if not env.get("PDFTOOL_SECRET"):
        updates["PDFTOOL_SECRET"] = secrets.token_urlsafe(32)
    if not env.get("PDFTOOL_USER"):
        updates["PDFTOOL_USER"] = "admin"
    if env.get("PDFTOOL_PASSWORD"):  # plain password given (e.g. Docker env) → use its hash
        env["PDFTOOL_PASSWORD_HASH"] = hash_password(env["PDFTOOL_PASSWORD"])
    elif not env.get("PDFTOOL_PASSWORD_HASH"):
        generated = secrets.token_urlsafe(9)
        updates["PDFTOOL_PASSWORD_HASH"] = hash_password(generated)
    if updates:
        if not os.environ.get("PDFTOOL_NO_ENV_WRITE"):
            write_env(updates)
        env.update(updates)
    return env, generated


class Throttle:
    """Lock an IP out for `lock_s` after `limit` failed logins inside `window_s`."""

    def __init__(self, limit: int = 8, window_s: int = 600, lock_s: int = 600):
        self.limit, self.window, self.lock = limit, window_s, lock_s
        self.fails: dict[str, list[float]] = {}

    def blocked(self, ip: str) -> int:
        now = time.time()
        hits = [t for t in self.fails.get(ip, []) if now - t < self.window]
        self.fails[ip] = hits
        if len(hits) >= self.limit:
            left = int(self.lock - (now - hits[-1]))
            if left > 0:
                return left
            self.fails.pop(ip, None)
        return 0

    def fail(self, ip: str) -> None:
        self.fails.setdefault(ip, []).append(time.time())

    def reset(self, ip: str) -> None:
        self.fails.pop(ip, None)
