# Gigabrain Web Console

Local-only FastAPI dashboard for browsing, editing, and managing the Gigabrain memory registry.

## Features

- **Memory browser** — search, filter, paginate, edit, confirm/reject memories
- **Concept dedup** — group by concept, select duplicates, bulk merge/reject
- **Audit queue** — review flagged items with reasons, advance through queue
- **Document store** — add text/URL/file documents, search, delete
- **Profile viewer** — static + dynamic profile facts at a glance
- **Knowledge graph** — interactive force-directed graph visualization
- **Metrics** — registry stats, scope breakdown, quality distribution

## Setup

1. Create a `.env` file (or copy `.env.example`):

```bash
cp .env.example .env
# Edit .env with your paths
```

2. Install dependencies:

```bash
pip install -r requirements.txt
```

3. Start the server:

```bash
uvicorn app:app --host 127.0.0.1 --port 7077
```

The UI is served at `http://127.0.0.1:7077/`.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GB_REGISTRY_PATH` | Yes | Path to the Gigabrain SQLite database |
| `GB_DOCS_PATH` | No | Directory for document store files |
| `GB_DOC_INDEX_AGENT` | No | Agent ID for doc indexing (default: `shared-docs`) |
| `GB_UI_TOKEN` | Yes | Auth token — all API requests must include `X-GB-Token: <token>` |

## Auth

All endpoints require the `X-GB-Token` header matching `GB_UI_TOKEN`.

If `GB_UI_TOKEN` is not set, **all requests are rejected** (fail-closed). The UI prompts for the token on first load and keeps it in memory for the current page session.

## Remote access

The server binds to `127.0.0.1` (loopback only). For remote access, use one of:

- **Tailscale serve** (recommended): `tailscale serve --bg 7077`
- **SSH tunnel**: `ssh -L 7077:127.0.0.1:7077 user@host`

Never bind to `0.0.0.0` in production.

## macOS (launchd)

Create a plist at `~/Library/LaunchAgents/com.gigabrain.memory-api.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.gigabrain.memory-api</string>
  <key>ProgramArguments</key>
  <array>
    <string>/path/to/venv/bin/uvicorn</string>
    <string>app:app</string>
    <string>--host</string>
    <string>127.0.0.1</string>
    <string>--port</string>
    <string>7077</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/path/to/gigabrain/memory_api</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>GB_REGISTRY_PATH</key>
    <string>/path/to/memory.db</string>
    <key>GB_UI_TOKEN</key>
    <string>your-secret-token</string>
  </dict>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
```

Load it:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.gigabrain.memory-api.plist
```

## Linux (systemd)

```ini
[Unit]
Description=Gigabrain Memory API
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/gigabrain/memory_api
EnvironmentFile=/path/to/.env
ExecStart=/path/to/venv/bin/uvicorn app:app --host 127.0.0.1 --port 7077
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/memories` | List memories (query, status, scope, sort, limit, offset) |
| `GET` | `/memories/{id}` | Get single memory |
| `POST` | `/memories` | Create memory |
| `PATCH` | `/memories/{id}` | Update memory |
| `POST` | `/memories/{id}/confirm` | Confirm pending memory |
| `POST` | `/memories/{id}/reject` | Reject memory |
| `POST` | `/memories/merge` | Merge duplicate memories |
| `GET` | `/concepts` | List concept groups |
| `GET` | `/audit` | List audit-flagged items |
| `GET` | `/docs` | List documents |
| `GET` | `/docs/{id}` | Get document |
| `POST` | `/docs` | Create document (text) |
| `POST` | `/docs/url` | Create document (from URL) |
| `POST` | `/docs/file` | Create document (file upload, max 10 MB) |
| `PATCH` | `/docs/{id}` | Update document |
| `DELETE` | `/docs/{id}` | Delete document |
| `GET` | `/profile` | Get agent profile |
| `POST` | `/recall/explain` | Recall with debug info |
| `GET` | `/graph` | Knowledge graph data |
| `GET` | `/metrics` | Registry statistics |

Interactive API docs at `/_docs` (Swagger) and `/_redoc` (ReDoc).

## Size limits

- File uploads: 10 MB max
- URL fetch: 5 MB max
