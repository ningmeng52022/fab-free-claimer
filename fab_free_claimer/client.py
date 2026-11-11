"""Thin client for the Fab web API used by the Fab website itself.

This talks to the same endpoints the Fab front-end calls. It is not an official
API: fields and routes may change without notice.
"""

from __future__ import annotations

import random
import re
import threading
import time
from typing import Any, Dict, Optional

import requests

API = "https://www.fab.com/i"
SEARCH = f"{API}/listings/search"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"
)


class AuthError(RuntimeError):
    """Raised when the session cookie is missing, expired or rejected."""


def read_cookie(path: str) -> str:
    with open(path, encoding="utf-8") as fh:
        cookie = fh.read().strip()
    if not cookie:
        raise SystemExit(f"cookie file is empty: {path}")
    return cookie


class FabClient:
    """Thread-safe-ish Fab client (one requests.Session per thread)."""

    def __init__(self, cookie: str, pool_size: int = 16, timeout: int = 45):
        self.cookie = cookie
        token = re.search(r"fab_csrftoken=([^;]+)", cookie)
        if not token:
            raise AuthError("cookie is missing fab_csrftoken")
        self.csrf = token.group(1)
        self.pool_size = max(1, pool_size)
        self.timeout = timeout
        self._local = threading.local()

    # ------------------------------------------------------------------ http
    def _session(self) -> requests.Session:
        sess = getattr(self._local, "sess", None)
        if sess is None:
            sess = requests.Session()
            adapter = requests.adapters.HTTPAdapter(
                pool_connections=self.pool_size,
                pool_maxsize=self.pool_size,
                max_retries=0,
            )
            sess.mount("https://", adapter)
            sess.headers.update(
                {
                    "User-Agent": USER_AGENT,
                    "Cookie": self.cookie,
                    "X-CsrfToken": self.csrf,
                    "Accept": "application/json",
                    "Origin": "https://www.fab.com",
                    "Referer": "https://www.fab.com/",
                }
            )
            self._local.sess = sess
        return sess

    def get(self, url: str, tries: int = 3) -> Any:
        """GET a JSON document with bounded retries."""
        last: Optional[str] = None
        for attempt in range(tries):
            try:
                resp = self._session().get(url, timeout=self.timeout)
                if resp.status_code == 200:
                    return resp.json()
                last = f"HTTP {resp.status_code} for {url}"
                if resp.status_code in (401, 403):
                    raise AuthError(last)
            except AuthError:
                raise
            except Exception as exc:  # noqa: BLE001 - network layer
                last = str(exc)
            time.sleep(1.5 * (attempt + 1))
        raise RuntimeError(last)

    # ------------------------------------------------------------------- api
    def me(self) -> Dict[str, Any]:
        return self.get(f"{API}/users/me")

    def categories_tree(self) -> Dict[str, Dict[str, Any]]:
        tree = self.get(f"{API}/taxonomy/categories/tree")["results"]["bundle"]
        nodes: Dict[str, Dict[str, Any]] = {}

        def walk(items):
            for node in items:
                nodes[node["uid"]] = node
                walk(node.get("children") or [])

        walk(tree)
        return nodes

    def claim(self, uid: str, offer_id: str) -> str:
        """Add one listing to the library.

        Returns ``"ok"``, ``"fatal_401"``/``"fatal_403"``, ``"http_<code>"``
        or ``"retry_exhausted"``. Repeated calls are idempotent server-side.
        """
        for attempt in range(4):
            try:
                resp = self._session().post(
                    f"{API}/listings/{uid}/add-to-library",
                    files={"offer_id": (None, offer_id)},
                    timeout=self.timeout,
                )
                if resp.status_code in (200, 201, 204):
                    return "ok"
                if resp.status_code in (401, 403):
                    return f"fatal_{resp.status_code}"
                if resp.status_code in (429, 500, 502, 503, 504):
                    time.sleep(1.5 ** (attempt + 1) + random.random())
                    continue
                return f"http_{resp.status_code}"
            except Exception:  # noqa: BLE001 - network layer
                time.sleep(1.5 ** (attempt + 1) + random.random())
        return "retry_exhausted"

    def owned(self, uid: str) -> Optional[bool]:
        """Whether the account already owns a listing (``None`` if unknown)."""
        try:
            return bool(
                self.get(f"{API}/users/me/listings-states/{uid}", tries=2).get("acquired")
            )
        except Exception:  # noqa: BLE001 - network layer
            return None
