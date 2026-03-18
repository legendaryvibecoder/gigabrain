from fastapi import FastAPI, HTTPException, Request, Depends, UploadFile, File, Response, Query
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from collections import defaultdict, deque
import sqlite3
import os
import uuid
import json
import subprocess
import threading
import time
from io import BytesIO
from datetime import datetime, timedelta, timezone
from typing import Optional, Any
import re
import hmac
import logging
import ipaddress
import socket
from urllib.parse import urlparse

import httpx
from readability import Document
from bs4 import BeautifulSoup
from pypdf import PdfReader
from pydantic import BaseModel, ConfigDict, Field

_home = os.path.expanduser("~")
DB_PATH = os.getenv("GB_REGISTRY_PATH", os.path.join(_home, ".openclaw", "gigabrain", "memory", "registry.sqlite"))
TOKEN = os.getenv("GB_UI_TOKEN", "")
OPENCLAW_CONFIG_PATH = os.getenv("GB_OPENCLAW_CONFIG", os.path.join(_home, ".openclaw", "openclaw.json"))
DOCS_DIR = os.getenv("GB_DOCS_PATH", os.path.join(_home, ".openclaw", "gigabrain", "memory", "docs"))
DOC_INDEX_AGENT = os.getenv("GB_DOC_INDEX_AGENT", "shared-docs")
DOC_INDEX_DEBOUNCE_SECONDS = int(os.getenv("GB_DOC_INDEX_DEBOUNCE", "10"))
DOC_INDEX_TIMEOUT_SECONDS = int(os.getenv("GB_DOC_INDEX_TIMEOUT", "900"))
DOC_INDEX_LOCK_PATH = os.getenv("GB_DOC_INDEX_LOCK", os.path.join(_home, ".openclaw", "gigabrain", "memory", ".doc-index.lock"))
GRAPH_PATH = os.getenv("GB_GRAPH_PATH", os.path.join(_home, ".openclaw", "gigabrain", "memory", "graph.json"))
OUTPUT_DIR = os.getenv("GB_OUTPUT_DIR", os.path.realpath(os.path.join(os.path.dirname(DB_PATH), "..", "output")))
SURFACE_SUMMARY_PATH = os.getenv("GB_SURFACE_SUMMARY_PATH", os.path.join(OUTPUT_DIR, "memory-surface-summary.json"))
GB_RECALL_EXPLAIN_URL = os.getenv("GB_RECALL_EXPLAIN_URL", "http://127.0.0.1:18789/gb/recall/explain")
ALLOW_PRIVATE_URLS = os.getenv("GB_ALLOW_PRIVATE_URLS", "").lower() in ("1", "true", "yes")
ENABLE_API_DOCS = os.getenv("GB_ENABLE_API_DOCS", "").lower() in ("1", "true", "yes")
MAX_UPLOAD_BYTES = 10 * 1024 * 1024  # 10 MB
MAX_FETCH_BYTES = 5 * 1024 * 1024  # 5 MB
SQLITE_BUSY_TIMEOUT_MS = max(0, int(os.getenv("GB_SQLITE_BUSY_TIMEOUT_MS", "5000")))
RATE_LIMIT_PER_MIN = max(1, int(os.getenv("GB_API_RATE_LIMIT_PER_MIN", "120")))
RATE_LIMIT_WINDOW_SECONDS = 60

_doc_index_timer = None
_doc_index_lock = threading.Lock()
_rate_limit_lock = threading.Lock()
_rate_limit_buckets = defaultdict(deque)

_logging = logging.getLogger("gigabrain")
if not TOKEN:
    _logging.warning("GB_UI_TOKEN is not set — authenticated endpoints will reject all requests")


def _load_gateway_token() -> str:
    for env_name in ("GB_GATEWAY_TOKEN", "OPENCLAW_GATEWAY_TOKEN"):
        candidate = str(os.getenv(env_name, "")).strip()
        if candidate:
            return candidate
    try:
        with open(OPENCLAW_CONFIG_PATH, "r", encoding="utf-8") as fh:
            config = json.load(fh)
        return str((((config.get("gateway") or {}).get("auth") or {}).get("token")) or "").strip()
    except Exception:
        return ""


PLUGIN_PROXY_TOKEN = str(TOKEN or _load_gateway_token()).strip()

SCOPE_TOKENS = {}
_raw_scope_tokens = os.getenv("GB_UI_SCOPE_TOKENS", "").strip()
if _raw_scope_tokens:
    try:
        parsed = json.loads(_raw_scope_tokens)
        if isinstance(parsed, dict):
            SCOPE_TOKENS = {
                str(scope).strip(): str(token).strip()
                for scope, token in parsed.items()
                if str(scope).strip() and str(token).strip()
            }
    except Exception:
        _logging.warning("Invalid GB_UI_SCOPE_TOKENS JSON; ignoring scope token map")

app = FastAPI(
    title="Gigabrain Memory API",
    docs_url="/_docs" if ENABLE_API_DOCS else None,
    redoc_url="/_redoc" if ENABLE_API_DOCS else None,
    openapi_url="/openapi.json" if ENABLE_API_DOCS else None,
)


@app.exception_handler(Exception)
async def _global_exception_handler(request: Request, exc: Exception):
    _logging.exception("Unhandled API exception on %s", request.url.path)
    return JSONResponse(status_code=500, content={"detail": "internal error"})


def _rate_limit_key(request: Request) -> str:
    token = str(request.headers.get("X-GB-Token", "")).strip()
    client = request.client.host if request.client else "unknown"
    principal = f"token:{token[:16]}" if token else f"ip:{client}"
    return f"{principal}:{request.url.path}"


@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    path = request.url.path
    if path.startswith("/static") or path in {"/", "/_docs", "/_redoc", "/openapi.json"}:
        return await call_next(request)

    now = time.time()
    cutoff = now - RATE_LIMIT_WINDOW_SECONDS
    key = _rate_limit_key(request)

    with _rate_limit_lock:
        bucket = _rate_limit_buckets[key]
        while bucket and bucket[0] <= cutoff:
            bucket.popleft()
        if len(bucket) >= RATE_LIMIT_PER_MIN:
            return JSONResponse(
                status_code=429,
                content={
                    "detail": "rate limit exceeded",
                    "retry_after_s": max(1, int(RATE_LIMIT_WINDOW_SECONDS - (now - bucket[0]))),
                },
            )
        bucket.append(now)

    return await call_next(request)


@app.middleware("http")
async def no_cache_middleware(request: Request, call_next):
    # This console is for local/Tailscale use; avoid stale JS/CSS after deploys.
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    return response


def require_token(request: Request) -> dict:
    candidate = str(request.headers.get("X-GB-Token", "")).strip()
    if not candidate:
        raise HTTPException(status_code=401, detail="Unauthorized")

    if TOKEN and hmac.compare_digest(candidate, TOKEN):
        return {"is_admin": True, "allowed_scopes": []}

    for scope, scoped_token in SCOPE_TOKENS.items():
        if hmac.compare_digest(candidate, scoped_token):
            return {"is_admin": False, "allowed_scopes": [scope]}

    if not TOKEN and not SCOPE_TOKENS:
        raise HTTPException(status_code=401, detail="GB_UI_TOKEN not configured")
    raise HTTPException(status_code=401, detail="Unauthorized")


def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=max(1.0, SQLITE_BUSY_TIMEOUT_MS / 1000.0))
    conn.execute(f"PRAGMA busy_timeout = {SQLITE_BUSY_TIMEOUT_MS}")
    conn.row_factory = sqlite3.Row
    return conn


def _is_admin(auth: dict) -> bool:
    return bool(auth and auth.get("is_admin"))


def _allowed_scopes(auth: dict) -> set[str]:
    return {
        str(scope).strip()
        for scope in (auth or {}).get("allowed_scopes", [])
        if str(scope).strip()
    }


def _apply_scope_filter(clauses: list[str], params: list[Any], scope: Optional[str], auth: dict) -> None:
    requested = (scope or "").strip()
    if _is_admin(auth):
        if requested:
            if requested.endswith("*"):
                clauses.append("scope LIKE ?")
                params.append(requested[:-1] + "%")
            else:
                clauses.append("scope = ?")
                params.append(requested)
        return

    allowed = _allowed_scopes(auth)
    if not allowed:
        raise HTTPException(status_code=403, detail="No scope access")
    if requested:
        if requested.endswith("*"):
            raise HTTPException(status_code=403, detail="Wildcard scope not allowed")
        if requested not in allowed:
            raise HTTPException(status_code=403, detail="Scope forbidden")
        clauses.append("scope = ?")
        params.append(requested)
        return
    if len(allowed) == 1:
        only_scope = next(iter(allowed))
        clauses.append("scope = ?")
        params.append(only_scope)
        return
    placeholders = ",".join("?" for _ in sorted(allowed))
    clauses.append(f"scope IN ({placeholders})")
    params.extend(sorted(allowed))


def _ensure_scope_allowed(scope: str, auth: dict) -> None:
    if _is_admin(auth):
        return
    allowed = _allowed_scopes(auth)
    if scope not in allowed:
        raise HTTPException(status_code=403, detail="Scope forbidden")


def _resolve_single_scope(scope: Optional[str], auth: dict) -> str:
    requested = (scope or "").strip()
    if _is_admin(auth):
        return requested
    allowed = _allowed_scopes(auth)
    if not allowed:
        raise HTTPException(status_code=403, detail="No scope access")
    if requested:
        if requested.endswith("*"):
            raise HTTPException(status_code=403, detail="Wildcard scope not allowed")
        if requested not in allowed:
            raise HTTPException(status_code=403, detail="Scope forbidden")
        return requested
    if len(allowed) == 1:
        return next(iter(allowed))
    raise HTTPException(status_code=400, detail="Explicit scope required")


def _ensure_doc_access(auth: dict) -> None:
    if _is_admin(auth):
        return
    raise HTTPException(status_code=403, detail="Document endpoints require admin token")


def _memory_scope_or_404(conn: sqlite3.Connection, memory_id: str, auth: dict) -> str:
    row = conn.execute("SELECT scope FROM memories WHERE id = ?", (memory_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Not found")
    scope = str(row["scope"] or "shared")
    _ensure_scope_allowed(scope, auth)
    return scope


def _escape_like(value: str) -> str:
    return str(value or "").replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _contains_like(value: str) -> str:
    return f"%{_escape_like(value)}%"


def _tag_like(tag: str) -> str:
    return f"%\"{_escape_like(tag)}\"%"


def _is_within_docs_dir(file_path: str) -> bool:
    if not file_path:
        return False
    try:
        docs_root = os.path.realpath(DOCS_DIR)
        target = os.path.realpath(file_path)
        return os.path.commonpath([docs_root, target]) == docs_root
    except Exception:
        return False


def _has_table(conn: sqlite3.Connection, table_name: str) -> bool:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
        (str(table_name or ""),),
    ).fetchone()
    return bool(row and row["name"])


def _require_admin_world(auth: dict) -> None:
    if not _is_admin(auth):
        raise HTTPException(status_code=403, detail="World-model endpoints require admin token")


def _default_surface_summary() -> dict:
    return {
        "generated_at": None,
        "active_nodes": 0,
        "source_files": 0,
        "counts": {
            "by_status": {},
            "by_type": [],
            "by_scope": [],
            "by_source_layer": {},
        },
        "native_sources": {
            "total": 0,
            "last_source_at": None,
            "last_daily_note_at": None,
            "items": [],
        },
        "review_queue": {
            "total": 0,
            "pending": 0,
            "items": [],
        },
        "recent_archives": {
            "count": 0,
            "items": [],
        },
        "freshness": {
            "native": {
                "last_source_at": None,
                "last_daily_note_at": None,
                "stale": True,
                "daily_note_stale": True,
            },
            "vault": {
                "last_built_at": None,
                "stale": True,
            },
            "manual_protection": {
                "ok": True,
                "issues": [],
            },
        },
        "reports": {
            "latest_nightly": {
                "source_path": "",
            },
            "latest_native_sync": {
                "source_path": "",
            },
        },
        "surface_summary_path": SURFACE_SUMMARY_PATH,
    }


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class MemoryCreatePayload(StrictModel):
    id: Optional[str] = None
    content: str = Field(min_length=1, max_length=20_000)
    type: str = Field(default="CONTEXT", min_length=1, max_length=64)
    source: str = Field(default="user", min_length=1, max_length=64)
    source_agent: Optional[str] = Field(default="ui", max_length=256)
    source_session: Optional[str] = Field(default="ui", max_length=256)
    source_message_id: Optional[str] = Field(default=None, max_length=256)
    confidence: float = Field(default=0.7, ge=0.0, le=1.0)
    status: str = Field(default="active", min_length=1, max_length=64)
    scope: str = Field(default="shared", min_length=1, max_length=255)
    tags: list[str] = Field(default_factory=list)
    last_confirmed_at: Optional[str] = None
    ttl_days: Optional[int] = Field(default=None, ge=1, le=3650)
    content_time: Optional[str] = None
    valid_until: Optional[str] = None
    pinned: bool = False
    superseded_by: Optional[str] = Field(default=None, max_length=128)


class MemoryUpdatePayload(StrictModel):
    content: Optional[str] = Field(default=None, min_length=1, max_length=20_000)
    type: Optional[str] = Field(default=None, min_length=1, max_length=64)
    status: Optional[str] = Field(default=None, min_length=1, max_length=64)
    ttl_days: Optional[int] = Field(default=None, ge=1, le=3650)
    content_time: Optional[str] = None
    valid_until: Optional[str] = None
    pinned: Optional[bool] = None
    superseded_by: Optional[str] = Field(default=None, max_length=128)
    confidence: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    tags: Optional[list[str]] = None


class DocCreatePayload(StrictModel):
    id: Optional[str] = None
    title: Optional[str] = None
    source: Optional[str] = None
    url: Optional[str] = None
    tags: list[str] = Field(default_factory=list)
    content: str = Field(min_length=1, max_length=2_000_000)
    status: str = Field(default="active", min_length=1, max_length=64)


class DocFromUrlPayload(StrictModel):
    url: str = Field(min_length=1, max_length=2048)
    tags: list[str] = Field(default_factory=list)


class DocUpdatePayload(StrictModel):
    title: Optional[str] = None
    source: Optional[str] = None
    url: Optional[str] = None
    tags: Optional[list[str]] = None
    status: Optional[str] = Field(default=None, min_length=1, max_length=64)
    content: Optional[str] = Field(default=None, min_length=1, max_length=2_000_000)


class MergeMemoriesPayload(StrictModel):
    ids: list[str] = Field(min_length=2)


class RecallExplainPayload(StrictModel):
    query: str = Field(min_length=1, max_length=1000)
    scope: Optional[str] = Field(default=None, max_length=255)


def normalize_content(content: str) -> str:
    if not content:
        return ""
    import re
    normalized = content.lower()
    normalized = re.sub(r"\[m:[0-9a-f-]+\]", "", normalized)
    normalized = re.sub(r"[^a-z0-9\s]", " ", normalized)
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return normalized


def _parse_iso(value: str) -> Optional[datetime]:
    if not value:
        return None
    raw = value.strip()
    if not raw:
        return None
    # Normalize trailing Z for fromisoformat.
    raw = raw.replace("Z", "")
    try:
        return datetime.fromisoformat(raw)
    except Exception:
        return None


def _is_expired(row: dict, now: datetime) -> bool:
    try:
        valid_until = _parse_iso(row.get("valid_until") or "")
        if valid_until and valid_until < now:
            return True
    except Exception:
        pass
    try:
        ttl_days = row.get("ttl_days")
        if ttl_days is None:
            return False
        created_at = _parse_iso(row.get("created_at") or "")
        if not created_at:
            return False
        until = created_at + timedelta(days=int(ttl_days))
        return until < now
    except Exception:
        return False


def ensure_docs_dir():
    os.makedirs(DOCS_DIR, exist_ok=True)
    os.makedirs(os.path.join(DOCS_DIR, "raw"), exist_ok=True)


def sanitize_title(title: str) -> str:
    title = (title or "").strip()
    title = re.sub(r"\s+", " ", title)
    return title[:200] if title else "Untitled document"


def strip_front_matter(text: str) -> str:
    return re.sub(r"^---[\s\S]*?---\s*", "", text).strip()


def _host_is_private(hostname: str) -> bool:
    if not hostname:
        return True
    host = hostname.lower()
    if host in ("localhost", "0.0.0.0"):
        return True
    if host.endswith(".local") or host.endswith(".internal"):
        return True
    try:
        ip = ipaddress.ip_address(host)
        return ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast
    except ValueError:
        # Not a raw IP, resolve DNS
        try:
            for info in socket.getaddrinfo(host, None):
                addr = info[4][0]
                ip = ipaddress.ip_address(addr)
                if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
                    return True
        except Exception:
            return True
    return False


def is_public_http_url(url: str) -> bool:
    if not url:
        return False
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return False
    return not _host_is_private(parsed.hostname or "")


def _safe_doc_filename(doc_id: str) -> str:
    raw = doc_id.split(":", 1)[-1]
    # Sanitize: only allow alphanumeric, hyphens, underscores
    sanitized = re.sub(r'[^a-zA-Z0-9_-]', '', raw)
    if not sanitized:
        raise ValueError(f"invalid doc_id: {doc_id}")
    return sanitized


def _yaml_scalar(value: Optional[str]) -> str:
    normalized = str(value or "").replace("\r", " ").replace("\n", " ").strip()
    return json.dumps(normalized, ensure_ascii=False)


def write_doc_file(doc_id: str, title: str, source: str, url: str, tags: list, content: str, created_at: str) -> str:
    ensure_docs_dir()
    doc_uuid = _safe_doc_filename(doc_id)
    file_path = os.path.join(DOCS_DIR, f"{doc_uuid}.md")
    front_matter = [
        "---",
        f"id: {doc_id}",
        f"title: {sanitize_title(title)}",
        f"source: {_yaml_scalar(source)}",
        f"url: {_yaml_scalar(url)}",
        f"tags: {json.dumps(tags or [])}",
        f"created_at: {created_at}",
        "---",
        "",
    ]
    body = (content or "").strip()
    with open(file_path, "w", encoding="utf-8") as f:
        f.write("\n".join(front_matter) + body + "\n")
    return file_path


def read_doc_content(file_path: str) -> str:
    if not file_path or not _is_within_docs_dir(file_path) or not os.path.exists(file_path):
        return ""
    with open(file_path, "r", encoding="utf-8") as f:
        return f.read()


def preview_doc_content(file_path: str, limit: int = 240) -> str:
    raw = read_doc_content(file_path)
    raw = strip_front_matter(raw)
    raw = re.sub(r"\s+", " ", raw).strip()
    return raw[:limit]


def extract_text_from_html(html: str) -> tuple[str, str]:
    title = ""
    content = ""
    try:
        doc = Document(html)
        title = doc.short_title() or ""
        summary_html = doc.summary() or ""
        soup = BeautifulSoup(summary_html, "lxml")
        content = soup.get_text("\n")
    except Exception:
        soup = BeautifulSoup(html, "lxml")
        title = soup.title.string.strip() if soup.title and soup.title.string else ""
        content = soup.get_text("\n")
    return sanitize_title(title), content.strip()


def extract_text_from_pdf(data: bytes) -> str:
    reader = PdfReader(BytesIO(data))
    pages = []
    for page in reader.pages:
        pages.append(page.extract_text() or "")
    return "\n".join(pages).strip()


def _doc_index_lock_recent(max_age_seconds: int = 1800) -> bool:
    if not os.path.exists(DOC_INDEX_LOCK_PATH):
        return False
    try:
        age = time.time() - os.path.getmtime(DOC_INDEX_LOCK_PATH)
        return age < max_age_seconds
    except Exception:
        return True


def run_doc_index():
    if _doc_index_lock_recent():
        return
    try:
        with open(DOC_INDEX_LOCK_PATH, "w", encoding="utf-8") as f:
            f.write(str(time.time()))
        cmd = ["openclaw", "memory", "index", "--agent", DOC_INDEX_AGENT, "--force"]
        result = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=DOC_INDEX_TIMEOUT_SECONDS)
        if result.returncode == 0:
            conn = get_db()
            now = datetime.now(timezone.utc).isoformat() + "Z"
            conn.execute("UPDATE documents SET last_indexed_at = ? WHERE status != 'deleted'", (now,))
            conn.commit()
            conn.close()
    finally:
        try:
            os.remove(DOC_INDEX_LOCK_PATH)
        except Exception:
            pass


def schedule_doc_index():
    global _doc_index_timer
    with _doc_index_lock:
        if _doc_index_timer:
            _doc_index_timer.cancel()
        _doc_index_timer = threading.Timer(DOC_INDEX_DEBOUNCE_SECONDS, run_doc_index)
        _doc_index_timer.daemon = True
        _doc_index_timer.start()


def init_db():
    conn = get_db()
    conn.executescript(
        """
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS memories (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            content TEXT NOT NULL,
            normalized TEXT NOT NULL,
            concept TEXT,
            source TEXT NOT NULL,
            source_agent TEXT,
            source_session TEXT,
            source_message_id TEXT,
            confidence REAL,
            status TEXT,
            scope TEXT,
            tags TEXT,
            created_at TEXT,
            updated_at TEXT,
            last_injected_at TEXT,
            last_confirmed_at TEXT,
            ttl_days INTEGER,
            content_time TEXT,
            valid_until TEXT,
            pinned INTEGER DEFAULT 0,
            superseded_by TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_memories_normalized ON memories(normalized, type);
        CREATE INDEX IF NOT EXISTS idx_memories_scope_normalized ON memories(scope, normalized);
        CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
        CREATE INDEX IF NOT EXISTS idx_memories_scope_created ON memories(scope, created_at);
        CREATE TABLE IF NOT EXISTS memory_relations (
            id TEXT PRIMARY KEY,
            from_memory_id TEXT NOT NULL,
            to_memory_id TEXT NOT NULL,
            relation_type TEXT NOT NULL,
            created_at TEXT,
            source TEXT,
            confidence REAL
        );
        CREATE INDEX IF NOT EXISTS idx_memory_relations_from ON memory_relations(from_memory_id);
        CREATE INDEX IF NOT EXISTS idx_memory_relations_to ON memory_relations(to_memory_id);
        CREATE INDEX IF NOT EXISTS idx_memory_relations_type ON memory_relations(relation_type);
        CREATE TABLE IF NOT EXISTS evidence (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            memory_id TEXT,
            text_snippet TEXT,
            created_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_evidence_memory_id ON evidence(memory_id);
        CREATE TABLE IF NOT EXISTS documents (
            id TEXT PRIMARY KEY,
            title TEXT,
            source TEXT,
            url TEXT,
            path TEXT,
            status TEXT,
            tags TEXT,
            created_at TEXT,
            updated_at TEXT,
            last_indexed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
        CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(path);
        """
    )
    # Back-compat: add concept column/index if registry predates Phase 6.
    try:
        conn.execute("ALTER TABLE memories ADD COLUMN concept TEXT")
    except Exception:
        pass
    try:
        conn.execute("CREATE INDEX IF NOT EXISTS idx_memories_scope_concept ON memories(scope, concept)")
    except Exception:
        pass

    # Phase 6: temporal fields (idempotent).
    try:
        conn.execute("ALTER TABLE memories ADD COLUMN content_time TEXT")
    except Exception:
        pass
    try:
        conn.execute("ALTER TABLE memories ADD COLUMN valid_until TEXT")
    except Exception:
        pass

    # Backfill valid_until from legacy ttl_days when present.
    try:
        rows = conn.execute(
            "SELECT id, created_at, ttl_days FROM memories WHERE valid_until IS NULL AND ttl_days IS NOT NULL"
        ).fetchall()
        now = datetime.now(timezone.utc)
        for r in rows or []:
            try:
                created_raw = (r["created_at"] or "").replace("Z", "")
                created_at = datetime.fromisoformat(created_raw) if created_raw else None
            except Exception:
                created_at = None
            try:
                ttl_days = int(r["ttl_days"]) if r["ttl_days"] is not None else None
            except Exception:
                ttl_days = None
            if not created_at or not ttl_days or ttl_days <= 0:
                continue
            until = created_at + timedelta(days=ttl_days)
            conn.execute("UPDATE memories SET valid_until = ? WHERE id = ?", (until.isoformat() + "Z", r["id"]))
    except Exception:
        pass
    conn.commit()
    conn.close()


from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app):
    init_db()
    ensure_docs_dir()
    yield

app.router.lifespan_context = lifespan


@app.get("/", response_class=HTMLResponse)
def index(response: Response):
    response.headers["Cache-Control"] = "no-store"
    with open(os.path.join(os.path.dirname(__file__), "static", "index.html"), "r", encoding="utf-8") as f:
        return f.read()


app.mount("/static", StaticFiles(directory=os.path.join(os.path.dirname(__file__), "static")), name="static")


@app.get("/memories")
def list_memories(
    query: Optional[str] = None,
    type: Optional[str] = None,
    status: Optional[str] = None,
    scope: Optional[str] = None,
    normalized: Optional[str] = None,
    concept: Optional[str] = None,
    tag: Optional[str] = None,
    sort: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
    auth: dict = Depends(require_token),
):
    conn = get_db()
    clauses = []
    params = []

    if query:
        clauses.append("(content LIKE ? ESCAPE '\\' OR normalized LIKE ? ESCAPE '\\' OR concept LIKE ? ESCAPE '\\')")
        like = _contains_like(query)
        params.extend([like, like, like])
    if type:
        clauses.append("type = ?")
        params.append(type)
    if status:
        clauses.append("status = ?")
        params.append(status)
    _apply_scope_filter(clauses, params, scope, auth)
    if normalized:
        clauses.append("normalized = ?")
        params.append(normalized.strip())
    if concept:
        clauses.append("COALESCE(concept, normalized) = ?")
        params.append(concept.strip())
    if tag:
        clauses.append("tags LIKE ? ESCAPE '\\'")
        params.append(_tag_like(tag))

    where = "WHERE " + " AND ".join(clauses) if clauses else ""
    sort_key = (sort or "recent").lower()
    if sort_key in ("confidence", "conf", "score"):
        order_by = "confidence DESC, updated_at DESC"
    elif sort_key in ("confidence_asc", "conf_asc", "score_asc"):
        order_by = "confidence ASC, updated_at DESC"
    elif sort_key == "oldest":
        order_by = "updated_at ASC"
    else:
        order_by = "updated_at DESC"
    sql = f"SELECT * FROM memories {where} ORDER BY {order_by} LIMIT ? OFFSET ?"
    count_sql = f"SELECT COUNT(*) as c FROM memories {where}"
    total = conn.execute(count_sql, params).fetchone()[0]

    params.extend([limit, offset])

    rows = conn.execute(sql, params).fetchall()
    conn.close()
    data = [dict(row) for row in rows]
    response = JSONResponse(content=data)
    response.headers["X-Total-Count"] = str(total)
    return response


@app.get("/concepts")
def list_concepts(
    query: Optional[str] = None,
    scope: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
    auth: dict = Depends(require_token),
):
    """
    Group memories by a stable "concept" key so wording variants collapse into one group.
    (Back-compat: falls back to normalized when concept is missing.)
    """
    conn = get_db()
    clauses = ["COALESCE(concept, normalized) != ''"]
    params = []

    if query:
        clauses.append("(content LIKE ? ESCAPE '\\' OR normalized LIKE ? ESCAPE '\\' OR concept LIKE ? ESCAPE '\\')")
        like = _contains_like(query)
        params.extend([like, like, like])
    if status:
        clauses.append("status = ?")
        params.append(status)
    _apply_scope_filter(clauses, params, scope, auth)

    where = "WHERE " + " AND ".join(clauses) if clauses else ""
    total_sql = f"SELECT COUNT(*) as c FROM (SELECT COALESCE(concept, normalized) AS concept_key FROM memories {where} GROUP BY concept_key)"
    total = conn.execute(total_sql, params).fetchone()[0]

    status_rank = """
        CASE status
            WHEN 'active' THEN 0
            WHEN 'pending' THEN 1
            WHEN 'superseded' THEN 2
            WHEN 'rejected' THEN 3
            ELSE 4
        END
    """

    sql = f"""
        WITH filtered AS (
            SELECT *, COALESCE(concept, normalized) AS concept_key FROM memories {where}
        ),
        groups AS (
            SELECT
                concept_key,
                COUNT(*) AS count,
                SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_count,
                SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected_count,
                SUM(CASE WHEN status = 'superseded' THEN 1 ELSE 0 END) AS superseded_count,
                MAX(updated_at) AS latest_updated_at
            FROM filtered
            GROUP BY concept_key
        )
        SELECT
            g.concept_key,
            g.count,
            g.active_count,
            g.rejected_count,
            g.superseded_count,
            g.latest_updated_at,
            c.id AS canonical_id,
            c.type AS canonical_type,
            c.status AS canonical_status,
            c.scope AS canonical_scope,
            c.confidence AS canonical_confidence,
            c.pinned AS canonical_pinned,
            c.content AS canonical_content
        FROM groups g
        JOIN filtered c ON c.id = (
            SELECT id FROM filtered f
            WHERE f.concept_key = g.concept_key
            ORDER BY
                pinned DESC,
                {status_rank} ASC,
                COALESCE(confidence, 0) DESC,
                updated_at DESC
            LIMIT 1
        )
        ORDER BY g.count DESC, g.latest_updated_at DESC
        LIMIT ? OFFSET ?
    """

    rows = conn.execute(sql, params + [limit, offset]).fetchall()
    conn.close()
    response = JSONResponse(content=[dict(r) for r in rows])
    response.headers["X-Total-Count"] = str(total)
    return response


@app.get("/audit")
def audit_memories(
    scope: Optional[str] = None,
    min_confidence: float = 0.6,
    limit: int = 100,
    offset: int = 0,
    auth: dict = Depends(require_token),
):
    """
    Surface suspicious "active" rows so the operator can clean up without spammy digests.
    """
    conn = get_db()
    clauses = ["status = 'active'"]
    params = []
    _apply_scope_filter(clauses, params, scope, auth)
    where = "WHERE " + " AND ".join(clauses)
    rows = conn.execute(f"SELECT * FROM memories {where} ORDER BY updated_at DESC", params).fetchall()
    conn.close()

    banned_re = re.compile(r"\b(openrouter|ollama|provider|model|embedding|api|token|sqlite|http|https|localhost|gateway|batch|v1/|11434)\b", re.I)
    secret_re = re.compile(r"\bsk-[a-z0-9]{10,}\b", re.I)
    metadata_re = re.compile(r"^\s*\*\*source\*\*\s*:\s*", re.I)
    trivial_re = re.compile(r"(?:^|\\b)(is a user|ist ein user|read heartbeat|working on.*plugin|\\bis (cool|nett|nice)\\b)(?:$|\\b)", re.I)

    findings = []
    for row in rows:
        r = dict(row)
        reasons = []
        content = (r.get("content") or "").strip()
        tags = r.get("tags") or ""
        if r.get("source") == "agent" and (banned_re.search(content) or secret_re.search(content)):
            reasons.append("agent_banned_tokens")
        if "\"agent-profile\"" in tags and (r.get("scope") == "shared" or not r.get("scope")):
            reasons.append("agent_profile_in_shared_scope")
        try:
            conf = float(r.get("confidence") or 0)
        except Exception:
            conf = 0.0
        if conf and conf < float(min_confidence):
            reasons.append("low_conf_active")
        if metadata_re.search(content):
            reasons.append("metadata_line")
        if len(content) < 12 or trivial_re.search(content):
            reasons.append("trivial_or_too_short")
        if reasons:
            r["reasons"] = reasons
            findings.append(r)

    total = len(findings)
    sliced = findings[offset: offset + limit]
    response = JSONResponse(content=sliced)
    response.headers["X-Total-Count"] = str(total)
    return response


@app.get("/memories/{memory_id}")
def get_memory(memory_id: str, auth: dict = Depends(require_token)):
    conn = get_db()
    row = conn.execute("SELECT * FROM memories WHERE id = ?", (memory_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Not found")
    _ensure_scope_allowed(str(row["scope"] or "shared"), auth)
    evidence = conn.execute("SELECT text_snippet, created_at FROM evidence WHERE memory_id = ?", (memory_id,)).fetchall()
    conn.close()
    data = dict(row)
    data["evidence"] = [dict(r) for r in evidence]
    return data


@app.post("/memories")
def create_memory(payload: MemoryCreatePayload, auth: dict = Depends(require_token)):
    mem_id = payload.id or str(uuid.uuid4())
    content = payload.content
    mem_type = payload.type or "CONTEXT"
    scope_value = (payload.scope or "shared").strip() or "shared"
    _ensure_scope_allowed(scope_value, auth)
    normalized = normalize_content(content)
    now = datetime.now(timezone.utc).isoformat() + "Z"
    tags = json.dumps(payload.tags or [])

    conn = get_db()
    conn.execute(
        """
        INSERT INTO memories (
            id, type, content, normalized, source, source_agent, source_session, source_message_id,
            confidence, status, scope, tags, created_at, updated_at, last_injected_at, last_confirmed_at,
            ttl_days, content_time, valid_until, pinned, superseded_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            mem_id,
            mem_type,
            content,
            normalized,
            payload.source or "user",
            payload.source_agent or "ui",
            payload.source_session or "ui",
            payload.source_message_id,
            payload.confidence,
            payload.status or "active",
            scope_value,
            tags,
            now,
            now,
            None,
            payload.last_confirmed_at,
            payload.ttl_days,
            payload.content_time,
            payload.valid_until,
            1 if payload.pinned else 0,
            payload.superseded_by,
        ),
    )
    conn.commit()
    conn.close()
    return {"id": mem_id}


@app.patch("/memories/{memory_id}")
def update_memory(memory_id: str, payload: MemoryUpdatePayload, auth: dict = Depends(require_token)):
    fields = []
    params = []
    payload_data = payload.model_dump(exclude_unset=True)
    for key in ["content", "type", "status", "ttl_days", "content_time", "valid_until", "pinned", "superseded_by", "confidence", "tags"]:
        if key in payload_data:
            fields.append(f"{key} = ?")
            if key == "tags":
                params.append(json.dumps(payload_data.get("tags") or []))
            elif key == "pinned":
                params.append(1 if payload_data.get("pinned") else 0)
            else:
                params.append(payload_data.get(key))
    if "content" in payload_data:
        fields.append("normalized = ?")
        params.append(normalize_content(payload_data.get("content")))

    conn = get_db()
    row = conn.execute("SELECT scope FROM memories WHERE id = ?", (memory_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Not found")
    _ensure_scope_allowed(str(row["scope"] or "shared"), auth)
    if not fields:
        conn.close()
        return {"ok": True}

    fields.append("updated_at = ?")
    params.append(datetime.now(timezone.utc).isoformat() + "Z")
    params.append(memory_id)

    conn.execute(f"UPDATE memories SET {', '.join(fields)} WHERE id = ?", params)
    conn.commit()
    conn.close()
    return {"ok": True}


@app.get("/docs")
def list_docs(
    query: Optional[str] = None,
    source: Optional[str] = None,
    status: Optional[str] = None,
    tag: Optional[str] = None,
    sort: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
    auth: dict = Depends(require_token),
):
    _ensure_doc_access(auth)
    conn = get_db()
    clauses = []
    params = []
    if query:
        clauses.append("(title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')")
        like = _contains_like(query)
        params.extend([like, like, like])
    if source:
        clauses.append("source = ?")
        params.append(source)
    if status:
        clauses.append("status = ?")
        params.append(status)
    if tag:
        clauses.append("tags LIKE ? ESCAPE '\\'")
        params.append(_tag_like(tag))
    where = "WHERE " + " AND ".join(clauses) if clauses else ""
    sort_key = (sort or "recent").lower()
    order_by = "updated_at ASC" if sort_key == "oldest" else "updated_at DESC"
    sql = f"SELECT * FROM documents {where} ORDER BY {order_by} LIMIT ? OFFSET ?"
    params.extend([limit, offset])
    count_sql = f"SELECT COUNT(*) as c FROM documents {where}"
    count_params = list(params[:-2])
    total = conn.execute(count_sql, count_params).fetchone()[0]

    rows = conn.execute(sql, params).fetchall()
    conn.close()
    out = []
    for row in rows:
        data = dict(row)
        data["preview"] = preview_doc_content(data.get("path"))
        out.append(data)
    response = JSONResponse(content=out)
    response.headers["X-Total-Count"] = str(total)
    return response


@app.get("/docs/{doc_id}")
def get_doc(doc_id: str, auth: dict = Depends(require_token)):
    _ensure_doc_access(auth)
    conn = get_db()
    row = conn.execute("SELECT * FROM documents WHERE id = ?", (doc_id,)).fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Not found")
    data = dict(row)
    data["content"] = read_doc_content(data.get("path"))
    return data


@app.post("/docs")
def create_doc(payload: DocCreatePayload, auth: dict = Depends(require_token)):
    _ensure_doc_access(auth)
    content = payload.content
    doc_id = payload.id or f"d:{uuid.uuid4()}"
    title = sanitize_title(payload.title or "Untitled document")
    source = payload.source or "text"
    url = payload.url or ""
    tags = payload.tags or []
    now = datetime.now(timezone.utc).isoformat() + "Z"
    file_path = write_doc_file(doc_id, title, source, url, tags, content, now)

    conn = get_db()
    conn.execute(
        """
        INSERT INTO documents (
            id, title, source, url, path, status, tags, created_at, updated_at, last_indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            doc_id,
            title,
            source,
            url,
            file_path,
            payload.status or "active",
            json.dumps(tags),
            now,
            now,
            None,
        ),
    )
    conn.commit()
    conn.close()
    schedule_doc_index()
    return {"id": doc_id, "path": file_path}


@app.post("/docs/url")
def create_doc_from_url(payload: DocFromUrlPayload, auth: dict = Depends(require_token)):
    _ensure_doc_access(auth)
    url = payload.url
    if not ALLOW_PRIVATE_URLS and not is_public_http_url(url):
        raise HTTPException(status_code=400, detail="private or non-http URL blocked")
    try:
        with httpx.Client(timeout=20) as client:
            resp = client.get(url, headers={"User-Agent": "Gigabrain/1.0"})
            resp.raise_for_status()
            if len(resp.content) > MAX_FETCH_BYTES:
                raise HTTPException(status_code=413, detail=f"Fetched content too large (max {MAX_FETCH_BYTES // (1024*1024)} MB)")
            title, content = extract_text_from_html(resp.text)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=400, detail="failed to fetch URL")

    return create_doc(
        DocCreatePayload(
            title=title,
            content=content,
            source="url",
            url=url,
            tags=payload.tags or [],
        ),
        auth,
    )


@app.post("/docs/file")
async def create_doc_from_file(file: UploadFile = File(...), auth: dict = Depends(require_token)):
    _ensure_doc_access(auth)
    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"File too large (max {MAX_UPLOAD_BYTES // (1024*1024)} MB)")
    filename = file.filename or "upload"
    ext = os.path.splitext(filename)[1].lower()
    content = ""
    source = "file"

    if ext == ".pdf" or file.content_type == "application/pdf":
        source = "pdf"
        content = extract_text_from_pdf(data)
    else:
        content = data.decode("utf-8", errors="ignore")

    doc_id = f"d:{uuid.uuid4()}"
    title = sanitize_title(filename)
    tags = []
    now = datetime.now(timezone.utc).isoformat() + "Z"
    file_path = write_doc_file(doc_id, title, source, "", tags, content, now)

    ensure_docs_dir()
    raw_path = os.path.join(DOCS_DIR, "raw", f"{doc_id.split(':',1)[-1]}{ext}")
    try:
        with open(raw_path, "wb") as f:
            f.write(data)
    except Exception:
        pass

    conn = get_db()
    conn.execute(
        """
        INSERT INTO documents (
            id, title, source, url, path, status, tags, created_at, updated_at, last_indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            doc_id,
            title,
            source,
            "",
            file_path,
            "active",
            json.dumps(tags),
            now,
            now,
            None,
        ),
    )
    conn.commit()
    conn.close()
    schedule_doc_index()
    return {"id": doc_id, "path": file_path}


@app.patch("/docs/{doc_id}")
def update_doc(doc_id: str, payload: DocUpdatePayload, auth: dict = Depends(require_token)):
    _ensure_doc_access(auth)
    payload_data = payload.model_dump(exclude_unset=True)
    conn = get_db()
    row = conn.execute("SELECT * FROM documents WHERE id = ?", (doc_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Not found")
    record = dict(row)
    title = sanitize_title(payload_data.get("title") or record.get("title") or "Untitled document")
    source = payload_data.get("source") or record.get("source") or "text"
    url = payload_data.get("url") if "url" in payload_data else (record.get("url") or "")
    tags = payload_data.get("tags") if "tags" in payload_data else json.loads(record.get("tags") or "[]")
    status = payload_data.get("status") or record.get("status") or "active"
    content = payload_data.get("content")
    if content is None:
        content = strip_front_matter(read_doc_content(record.get("path")))
    now = datetime.now(timezone.utc).isoformat() + "Z"
    file_path = write_doc_file(doc_id, title, source, url, tags, content, record.get("created_at") or now)

    conn.execute(
        """
        UPDATE documents SET title = ?, source = ?, url = ?, path = ?, status = ?, tags = ?, updated_at = ?
        WHERE id = ?
        """,
        (title, source, url, file_path, status, json.dumps(tags), now, doc_id),
    )
    conn.commit()
    conn.close()
    schedule_doc_index()
    return {"ok": True}


@app.delete("/docs/{doc_id}")
def delete_doc(doc_id: str, auth: dict = Depends(require_token)):
    _ensure_doc_access(auth)
    conn = get_db()
    row = conn.execute("SELECT * FROM documents WHERE id = ?", (doc_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Not found")
    record = dict(row)
    conn.execute(
        "UPDATE documents SET status = 'deleted', updated_at = ? WHERE id = ?",
        (datetime.now(timezone.utc).isoformat() + "Z", doc_id),
    )
    conn.commit()
    conn.close()
    try:
        if record.get("path") and _is_within_docs_dir(record["path"]) and os.path.exists(record["path"]):
            os.remove(record["path"])
    except Exception:
        pass
    schedule_doc_index()
    return {"ok": True}


@app.get("/profile")
def profile(
    mode: str = "full",
    q: Optional[str] = None,
    scope: str = "shared",
    dynamic_window_days: int = 14,
    max_static_items: int = 50,
    max_dynamic_items: int = 50,
    min_confidence: float = 0.7,
    auth: dict = Depends(require_token),
):
    """
    Profile endpoint:
    - mode=profile: return profile only
    - mode=query: return searchResults only (profile is empty)
    - mode=full: return profile + searchResults
    """
    mode_norm = (mode or "full").strip().lower()
    if mode_norm not in ("profile", "query", "full"):
        mode_norm = "full"

    scope_value = (scope or "shared").strip() or "shared"
    _ensure_scope_allowed(scope_value, auth)
    now = datetime.now(timezone.utc)
    since = now - timedelta(days=max(1, int(dynamic_window_days or 14)))

    conn = get_db()

    profile_static = []
    profile_dynamic = []

    if mode_norm in ("profile", "full"):
        static_rows = conn.execute(
            """
            SELECT * FROM memories
            WHERE scope = ? AND status = 'active'
              AND (pinned = 1 OR confidence >= ?)
              AND type IN ('USER_FACT','PREFERENCE','ENTITY','DECISION')
            ORDER BY pinned DESC, confidence DESC, updated_at DESC
            LIMIT ?
            """,
            (scope_value, float(min_confidence), int(max_static_items)),
        ).fetchall()
        for r in static_rows or []:
            row = dict(r)
            if _is_expired(row, now):
                continue
            profile_static.append(row)

        dynamic_rows = conn.execute(
            """
            SELECT * FROM memories
            WHERE scope = ? AND status = 'active'
              AND type IN ('CONTEXT','EPISODE')
              AND updated_at >= ?
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            (scope_value, since.isoformat() + "Z", int(max_dynamic_items)),
        ).fetchall()
        for r in dynamic_rows or []:
            row = dict(r)
            if _is_expired(row, now):
                continue
            profile_dynamic.append(row)

        # Recent updates (updates-only relations) are useful "dynamic" context.
        try:
            update_rows = conn.execute(
                """
                SELECT m.* FROM memories m
                JOIN memory_relations r ON r.to_memory_id = m.id
                WHERE m.scope = ? AND m.status = 'active'
                  AND r.relation_type = 'updates'
                  AND m.type IN ('USER_FACT','PREFERENCE','DECISION')
                  AND m.updated_at >= ?
                ORDER BY m.updated_at DESC
                LIMIT ?
                """,
                (scope_value, since.isoformat() + "Z", int(max_dynamic_items)),
            ).fetchall()
            seen = set([x.get("id") for x in profile_dynamic])
            for r in update_rows or []:
                row = dict(r)
                if row.get("id") in seen:
                    continue
                if _is_expired(row, now):
                    continue
                profile_dynamic.append(row)
                seen.add(row.get("id"))
                if len(profile_dynamic) >= int(max_dynamic_items):
                    break
        except Exception:
            pass

    search_results = []
    if mode_norm in ("query", "full") and q:
        tokens = normalize_content(q).split()
        if tokens:
            like = _contains_like(" ".join(tokens[:4]))
            rows = conn.execute(
                """
                SELECT * FROM memories
                WHERE scope = ? AND status = 'active'
                  AND (content LIKE ? ESCAPE '\\' OR normalized LIKE ? ESCAPE '\\' OR concept LIKE ? ESCAPE '\\')
                ORDER BY confidence DESC, updated_at DESC
                LIMIT 50
                """,
                (scope_value, like, like, like),
            ).fetchall()
            for r in rows or []:
                row = dict(r)
                if _is_expired(row, now):
                    continue
                search_results.append(row)

    conn.close()

    out = {
        "mode": mode_norm,
        "q": q,
        "profile": {
            "static": profile_static,
            "dynamic": profile_dynamic,
        },
    }
    if mode_norm in ("query", "full"):
        out["searchResults"] = search_results
    return out


@app.get("/memories/{memory_id}/relations")
def memory_relations(memory_id: str, auth: dict = Depends(require_token)):
    conn = get_db()
    _memory_scope_or_404(conn, memory_id, auth)
    rels = conn.execute(
        """
        SELECT * FROM memory_relations
        WHERE from_memory_id = ? OR to_memory_id = ?
        ORDER BY created_at DESC
        LIMIT 500
        """,
        (memory_id, memory_id),
    ).fetchall()
    conn.close()
    return {"id": memory_id, "relations": [dict(r) for r in rels]}


@app.get("/relations")
def list_relations(
    from_id: Optional[str] = Query(None, alias="from"),
    to_id: Optional[str] = Query(None, alias="to"),
    relation_type: str = "updates",
    limit: int = 200,
    auth: dict = Depends(require_token),
):
    clauses = []
    params = []
    from_memory_id = from_id
    to_memory_id = to_id
    if from_memory_id:
        clauses.append("from_memory_id = ?")
        params.append(from_memory_id)
    if to_memory_id:
        clauses.append("to_memory_id = ?")
        params.append(to_memory_id)
    if relation_type:
        clauses.append("relation_type = ?")
        params.append(relation_type)
    where = "WHERE " + " AND ".join(clauses) if clauses else ""

    conn = get_db()
    if from_memory_id:
        _memory_scope_or_404(conn, from_memory_id, auth)
    if to_memory_id:
        _memory_scope_or_404(conn, to_memory_id, auth)
    if not _is_admin(auth) and not from_memory_id and not to_memory_id:
        conn.close()
        raise HTTPException(status_code=403, detail="from/to filter required for scoped tokens")

    rows = conn.execute(
        f"SELECT * FROM memory_relations {where} ORDER BY created_at DESC LIMIT ?",
        params + [min(max(int(limit or 200), 1), 1000)],
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.post("/memories/{memory_id}/confirm")
def confirm_memory(memory_id: str, auth: dict = Depends(require_token)):
    conn = get_db()
    row = conn.execute("SELECT concept, normalized, scope FROM memories WHERE id = ?", (memory_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Not found")
    concept = row["concept"] or row["normalized"]
    scope = row["scope"]
    _ensure_scope_allowed(str(scope or "shared"), auth)
    now = datetime.now(timezone.utc).isoformat() + "Z"
    # Confirming a memory should make the concept canonical and supersede duplicates.
    conn.execute(
        "UPDATE memories SET status = 'active', last_confirmed_at = ?, updated_at = ? WHERE id = ?",
        (now, now, memory_id),
    )
    conn.execute(
        "UPDATE memories SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id != ? AND scope = ? AND (concept = ? OR (concept IS NULL AND normalized = ?))",
        (memory_id, now, memory_id, scope, concept, row["normalized"]),
    )
    conn.commit()
    conn.close()
    return {"ok": True}


@app.post("/memories/{memory_id}/reject")
def reject_memory(memory_id: str, auth: dict = Depends(require_token)):
    conn = get_db()
    row = conn.execute("SELECT concept, normalized, scope FROM memories WHERE id = ?", (memory_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Not found")
    concept = row["concept"] or row["normalized"]
    scope = row["scope"]
    _ensure_scope_allowed(str(scope or "shared"), auth)
    now = datetime.now(timezone.utc).isoformat() + "Z"
    # Rejecting should stick concept-wide so it doesn't "come back" as a new row with a different type.
    conn.execute(
        "UPDATE memories SET status = 'rejected', superseded_by = NULL, updated_at = ? WHERE scope = ? AND (concept = ? OR (concept IS NULL AND normalized = ?))",
        (now, scope, concept, row["normalized"]),
    )
    conn.commit()
    conn.close()
    return {"ok": True}


@app.post("/memories/merge")
def merge_memories(payload: MergeMemoriesPayload, auth: dict = Depends(require_token)):
    ids = payload.ids or []
    if len(ids) < 2:
        raise HTTPException(status_code=400, detail="ids required")
    primary = ids[0]
    conn = get_db()
    primary_scope = _memory_scope_or_404(conn, primary, auth)
    for mid in ids[1:]:
        scope = _memory_scope_or_404(conn, mid, auth)
        if scope != primary_scope:
            conn.close()
            raise HTTPException(status_code=400, detail="all memories must share scope")
    now = datetime.now(timezone.utc).isoformat() + "Z"
    for mid in ids[1:]:
        conn.execute(
            "UPDATE memories SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?",
            (primary, now, mid),
        )
        try:
            conn.execute(
                """
                INSERT INTO memory_relations (
                    id, from_memory_id, to_memory_id, relation_type, created_at, source, confidence
                ) VALUES (?, ?, ?, 'updates', ?, 'ui', 0.9)
                """,
                (str(uuid.uuid4()), mid, primary, now),
            )
        except Exception:
            pass
    conn.commit()
    conn.close()
    return {"ok": True, "primary": primary}


@app.post("/recall/explain")
def recall_explain(payload: RecallExplainPayload, auth: dict = Depends(require_token)):
    query = payload.query
    if not query.strip():
        return {"strategy": "quick_context", "result_count": 0, "results": []}
    effective_scope = _resolve_single_scope(payload.scope, auth)

    try:
        headers = {"Authorization": f"Bearer {PLUGIN_PROXY_TOKEN}"} if PLUGIN_PROXY_TOKEN else {}
        with httpx.Client(timeout=4.0) as client:
            response = client.post(
                GB_RECALL_EXPLAIN_URL,
                headers=headers,
                json={"query": query, "scope": effective_scope},
            )
            if response.status_code == 200:
                return response.json()
    except Exception:
        pass

    tokens = normalize_content(query).split()
    if not tokens:
        return {"strategy": "quick_context", "result_count": 0, "results": []}
    like = _contains_like(" ".join(tokens[:3]))

    conn = get_db()
    clauses = ["status = 'active'", "normalized LIKE ? ESCAPE '\\'"]
    params: list[Any] = [like]
    _apply_scope_filter(clauses, params, payload.scope, auth)
    where = " WHERE " + " AND ".join(clauses)
    rows = conn.execute(
        f"SELECT * FROM memories {where} ORDER BY confidence DESC LIMIT 10",
        params,
    ).fetchall()
    conn.close()
    return {
        "strategy": "fallback_sql_like",
        "deep_lookup_allowed": False,
        "used_world_model": False,
        "result_count": len(rows),
        "results": [dict(r) for r in rows],
    }


@app.get("/graph")
def graph(auth: dict = Depends(require_token)):
    if not _is_admin(auth):
        raise HTTPException(status_code=403, detail="Graph endpoint requires admin token")
    if not os.path.exists(GRAPH_PATH):
        return {"generated_at": None, "nodes": [], "edges": []}
    try:
        with open(GRAPH_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        if "nodes" not in data or "edges" not in data:
            return {"generated_at": None, "nodes": [], "edges": []}
        return data
    except Exception:
        return {"generated_at": None, "nodes": [], "edges": []}


@app.get("/surface")
def surface(auth: dict = Depends(require_token)):
    if not _is_admin(auth):
        raise HTTPException(status_code=403, detail="Surface endpoint requires admin token")
    if not os.path.exists(SURFACE_SUMMARY_PATH):
        return _default_surface_summary()
    try:
        with open(SURFACE_SUMMARY_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return _default_surface_summary()
        data.setdefault("surface_summary_path", SURFACE_SUMMARY_PATH)
        return data
    except Exception:
        return _default_surface_summary()


@app.get("/world/summary")
def world_summary(auth: dict = Depends(require_token)):
    _require_admin_world(auth)
    conn = get_db()
    try:
        if not _has_table(conn, "memory_entities"):
            return {
                "generated_at": None,
                "counts": {
                    "entities": 0,
                    "beliefs": 0,
                    "episodes": 0,
                    "open_loops": 0,
                    "contradictions": 0,
                    "syntheses": 0,
                },
                "latest_session_brief": None,
            }
        counts = {}
        entity_rows = conn.execute("SELECT payload FROM memory_entities").fetchall()
        visible_entities = 0
        for row in entity_rows:
            try:
                payload = json.loads(row["payload"] or "{}")
            except Exception:
                payload = {}
            if payload.get("surface_visible", True) is False:
                continue
            visible_entities += 1
        counts["entities"] = visible_entities
        for table_name in ["memory_beliefs", "memory_episodes", "memory_open_loops", "memory_syntheses"]:
            counts[table_name.replace("memory_", "")] = int(
                conn.execute(f"SELECT COUNT(*) AS c FROM {table_name}").fetchone()["c"] or 0
            )
        contradictions = int(
            conn.execute(
                "SELECT COUNT(*) AS c FROM memory_open_loops WHERE kind = 'contradiction_review'"
            ).fetchone()["c"] or 0
        )
        latest = conn.execute(
            """
            SELECT synthesis_id, kind, content, generated_at, confidence
            FROM memory_syntheses
            WHERE kind = 'session_brief'
            ORDER BY generated_at DESC
            LIMIT 1
            """
        ).fetchone()
        generated = conn.execute(
            "SELECT COALESCE(MAX(generated_at), '') AS generated_at FROM memory_syntheses"
        ).fetchone()["generated_at"]
        return {
            "generated_at": generated or None,
            "counts": {
                "entities": counts.get("entities", 0),
                "beliefs": counts.get("beliefs", 0),
                "episodes": counts.get("episodes", 0),
                "open_loops": counts.get("open_loops", 0),
                "contradictions": contradictions,
                "syntheses": counts.get("syntheses", 0),
            },
            "latest_session_brief": dict(latest) if latest else None,
        }
    finally:
        conn.close()


@app.get("/world/entities")
def world_entities(
    kind: Optional[str] = None,
    limit: int = 200,
    auth: dict = Depends(require_token),
):
    _require_admin_world(auth)
    conn = get_db()
    try:
        if not _has_table(conn, "memory_entities"):
            return []
        clauses = []
        params: list[Any] = []
        if kind:
            clauses.append("kind = ?")
            params.append(kind)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = conn.execute(
            f"""
            SELECT entity_id, kind, display_name, normalized_name, status, confidence, aliases, created_at, updated_at, payload
            FROM memory_entities
            {where}
            ORDER BY updated_at DESC, display_name ASC
            LIMIT ?
            """,
            (*params, max(1, min(limit, 1000))),
        ).fetchall()
        items = []
        for row in rows:
            payload = json.loads(row["payload"] or "{}")
            if payload.get("surface_visible", True) is False:
                continue
            items.append({
                **dict(row),
                "aliases": json.loads(row["aliases"] or "[]"),
                "payload": payload,
            })
        return items
    finally:
        conn.close()


@app.get("/world/entities/{entity_id}")
def world_entity_detail(entity_id: str, auth: dict = Depends(require_token)):
    _require_admin_world(auth)
    conn = get_db()
    try:
        if not _has_table(conn, "memory_entities"):
            raise HTTPException(status_code=404, detail="World model unavailable")
        entity = conn.execute(
            """
            SELECT entity_id, kind, display_name, normalized_name, status, confidence, aliases, created_at, updated_at, payload
            FROM memory_entities
            WHERE entity_id = ?
            LIMIT 1
            """,
            (entity_id,),
        ).fetchone()
        if not entity:
            raise HTTPException(status_code=404, detail="Entity not found")
        beliefs = conn.execute(
            """
            SELECT belief_id, entity_id, type, content, status, confidence, valid_from, valid_to,
                   supersedes_belief_id, source_memory_id, source_layer, source_path, source_line, payload
            FROM memory_beliefs
            WHERE entity_id = ?
            ORDER BY COALESCE(valid_from, '') DESC, confidence DESC
            LIMIT 200
            """,
            (entity_id,),
        ).fetchall()
        episodes = conn.execute(
            """
            SELECT episode_id, title, summary, start_date, end_date, status, primary_entity_id, source_memory_ids, payload
            FROM memory_episodes
            WHERE primary_entity_id = ?
            ORDER BY COALESCE(start_date, '') DESC
            LIMIT 100
            """,
            (entity_id,),
        ).fetchall()
        loops = conn.execute(
            """
            SELECT loop_id, kind, title, status, priority, related_entity_id, source_memory_ids, payload
            FROM memory_open_loops
            WHERE related_entity_id = ?
            ORDER BY priority DESC, title ASC
            LIMIT 100
            """,
            (entity_id,),
        ).fetchall()
        syntheses = conn.execute(
            """
            SELECT synthesis_id, kind, subject_type, subject_id, content, stale, confidence, generated_at, input_hash, payload
            FROM memory_syntheses
            WHERE subject_type = 'entity' AND subject_id = ?
            ORDER BY generated_at DESC, kind ASC
            LIMIT 50
            """,
            (entity_id,),
        ).fetchall()
        return {
            **dict(entity),
            "aliases": json.loads(entity["aliases"] or "[]"),
            "payload": json.loads(entity["payload"] or "{}"),
            "beliefs": [{**dict(row), "payload": json.loads(row["payload"] or "{}")} for row in beliefs],
            "episodes": [
                {
                    **dict(row),
                    "source_memory_ids": json.loads(row["source_memory_ids"] or "[]"),
                    "payload": json.loads(row["payload"] or "{}"),
                }
                for row in episodes
            ],
            "open_loops": [
                {
                    **dict(row),
                    "source_memory_ids": json.loads(row["source_memory_ids"] or "[]"),
                    "payload": json.loads(row["payload"] or "{}"),
                }
                for row in loops
            ],
            "syntheses": [
                {
                    **dict(row),
                    "stale": bool(row["stale"]),
                    "payload": json.loads(row["payload"] or "{}"),
                }
                for row in syntheses
            ],
        }
    finally:
        conn.close()


@app.get("/world/beliefs")
def world_beliefs(
    entity_id: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = 200,
    auth: dict = Depends(require_token),
):
    _require_admin_world(auth)
    conn = get_db()
    try:
        if not _has_table(conn, "memory_beliefs"):
            return []
        clauses = []
        params: list[Any] = []
        if entity_id:
            clauses.append("entity_id = ?")
            params.append(entity_id)
        if status:
            clauses.append("status = ?")
            params.append(status)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = conn.execute(
            f"""
            SELECT belief_id, entity_id, type, content, status, confidence, valid_from, valid_to,
                   supersedes_belief_id, source_memory_id, source_layer, source_path, source_line, payload
            FROM memory_beliefs
            {where}
            ORDER BY COALESCE(valid_from, '') DESC, confidence DESC
            LIMIT ?
            """,
            (*params, max(1, min(limit, 1000))),
        ).fetchall()
        return [{**dict(row), "payload": json.loads(row["payload"] or "{}")} for row in rows]
    finally:
        conn.close()


@app.get("/world/open-loops")
def world_open_loops(
    entity_id: Optional[str] = None,
    kind: Optional[str] = None,
    limit: int = 200,
    auth: dict = Depends(require_token),
):
    _require_admin_world(auth)
    conn = get_db()
    try:
        if not _has_table(conn, "memory_open_loops"):
            return []
        clauses = []
        params: list[Any] = []
        if entity_id:
            clauses.append("related_entity_id = ?")
            params.append(entity_id)
        if kind:
            clauses.append("kind = ?")
            params.append(kind)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = conn.execute(
            f"""
            SELECT loop_id, kind, title, status, priority, related_entity_id, source_memory_ids, payload
            FROM memory_open_loops
            {where}
            ORDER BY priority DESC, title ASC
            LIMIT ?
            """,
            (*params, max(1, min(limit, 1000))),
        ).fetchall()
        return [
            {
                **dict(row),
                "source_memory_ids": json.loads(row["source_memory_ids"] or "[]"),
                "payload": json.loads(row["payload"] or "{}"),
            }
            for row in rows
        ]
    finally:
        conn.close()


@app.get("/world/contradictions")
def world_contradictions(limit: int = 200, auth: dict = Depends(require_token)):
    return world_open_loops(kind="contradiction_review", limit=limit, auth=auth)


@app.get("/world/briefings")
def world_briefings(limit: int = 50, auth: dict = Depends(require_token)):
    _require_admin_world(auth)
    conn = get_db()
    try:
        if not _has_table(conn, "memory_syntheses"):
            return []
        rows = conn.execute(
            """
            SELECT synthesis_id, kind, subject_type, subject_id, content, stale, confidence, generated_at, input_hash, payload
            FROM memory_syntheses
            WHERE kind IN ('session_brief', 'daily_memory_briefing', 'what_changed', 'open_loops_report', 'contradiction_report')
            ORDER BY generated_at DESC, kind ASC
            LIMIT ?
            """,
            (max(1, min(limit, 200)),),
        ).fetchall()
        return [
            {
                **dict(row),
                "stale": bool(row["stale"]),
                "payload": json.loads(row["payload"] or "{}"),
            }
            for row in rows
        ]
    finally:
        conn.close()


@app.get("/metrics")
def metrics(auth: dict = Depends(require_token)):
    conn = get_db()
    allowed = sorted(_allowed_scopes(auth))
    if _is_admin(auth):
        total = conn.execute("SELECT COUNT(*) as c FROM memories").fetchone()[0]
        active = conn.execute("SELECT COUNT(*) as c FROM memories WHERE status = 'active'").fetchone()[0]
        pending = conn.execute("SELECT COUNT(*) as c FROM memories WHERE status = 'pending'").fetchone()[0]
        rejected = conn.execute("SELECT COUNT(*) as c FROM memories WHERE status = 'rejected'").fetchone()[0]
    elif allowed:
        placeholders = ",".join("?" for _ in allowed)
        total = conn.execute(f"SELECT COUNT(*) as c FROM memories WHERE scope IN ({placeholders})", allowed).fetchone()[0]
        active = conn.execute(
            f"SELECT COUNT(*) as c FROM memories WHERE status = 'active' AND scope IN ({placeholders})",
            allowed,
        ).fetchone()[0]
        pending = conn.execute(
            f"SELECT COUNT(*) as c FROM memories WHERE status = 'pending' AND scope IN ({placeholders})",
            allowed,
        ).fetchone()[0]
        rejected = conn.execute(
            f"SELECT COUNT(*) as c FROM memories WHERE status = 'rejected' AND scope IN ({placeholders})",
            allowed,
        ).fetchone()[0]
    else:
        total = active = pending = rejected = 0
    if _is_admin(auth):
        docs = conn.execute("SELECT COUNT(*) as c FROM documents").fetchone()[0]
        docs_active = conn.execute("SELECT COUNT(*) as c FROM documents WHERE status = 'active'").fetchone()[0]
    else:
        docs = 0
        docs_active = 0
    conn.close()
    return {
        "total": total,
        "active": active,
        "pending": pending,
        "rejected": rejected,
        "docs_total": docs,
        "docs_active": docs_active,
    }
