# Discovery — 2026-04-18

> Phase A findings for ROUND2_PLAN.md. No code was changed. All facts verified empirically.

---

## A.1 — PM2 processes

| Name | Status | PID | Script | CWD | autorestart |
|---|---|---|---|---|---|
| `ai-dashboard` | online | 21216 | `D:\AIAssist\dashboard\AI-Dashboard\server.js` | same dir | true |
| `memory-miner` | online | 17960 | `D:\AIAssist\whatsapp-bridge\memory-miner.js` | `D:\AIAssist\whatsapp-bridge` | true |

**`whatsapp-bridge` — NOT in PM2.** The bridge's `package.json` has a `pm2` npm script but it was never run; `bridge.js` is not a live process.

**`wechat-bridge` — NOT in PM2** and not running at all.

**PM2 pipe EPERM note:** Claude Code's bash shell cannot connect to `\\.\pipe\rpc.sock` (privilege boundary — PM2 daemon was started from a different terminal session). All PM2 commands must be run from the `/api/control` dashboard endpoint or CW's own terminal. This will affect Phase C instructions.

---

## A.2 — LM Studio

- **Installed:** YES
- **Path:** `D:\AIAssist\home\tools\adapters\lmstudio\LM Studio\LM Studio.exe`
  - Standard `%LOCALAPPDATA%\LM-Studio` and `%LOCALAPPDATA%\Programs\LM Studio` paths are **empty** — LM Studio is installed to a custom tools directory, not the default Squirrel location.
- **Version:** `0.4.12+1` (from `resources/app/package.json`)
- **Port:** `1234` (default; no `settings.json` with port override found anywhere)
- **App process running:** YES — 7 × `LM Studio.exe` processes (GUI + renderers). Starts at login via `HKCU\Run` key `electron.app.LM Studio` → `"...\LM Studio.exe" --run-as-service`.
- **Server running:** **NO** — `lms server status` returns *"The server is not running."* Port 1234 is not bound.
- **Live probe result:** `http://127.0.0.1:1234/v1/models` → connection refused.
- **`lms` CLI:** present at `D:\AIAssist\home\tools\adapters\lmstudio\LM Studio\resources\app\.webpack\lms.exe`; `lms --version` outputs `CLI commit: 0b2a176` — **not a usable version string**.
- **`/v1/models` sample:** N/A — server not running. When it is running, shape is `{"object":"list","data":[...models...]}`. LM Studio 0.4.x returns only the **currently loaded** model in `data`; empty `data` means no model loaded.

**Current manifest check is WRONG:**
- `software-manifest.json` entry uses `check: { kind: "cmd", cmd: "lms --version" }` — this returns an unhelpful commit hash and gives `ok` even when the server is off.
- **Correct check:** `compound` with `fs` sub-check (exe exists → installed) + `http` sub-check (1234 → live). Status matrix: both ok → `ok`; fs ok + http fail → `degraded` ("installed, server not started"); fs fail → `missing`.

**Phase B fix path:** Replace with:
```json
{ "kind": "compound", "checks": [
  { "id": "installed", "kind": "fs", "paths": ["D:\\AIAssist\\home\\tools\\adapters\\lmstudio\\LM Studio\\LM Studio.exe"] },
  { "id": "live",      "kind": "http", "url": "http://127.0.0.1:1234/v1/models" }
]}
```

---

## A.3 — Mempalace

- **Install kind:** pip (`python -m pip show mempalace`)
- **Version:** `3.1.0`
- **Location:** `C:\Users\warre\AppData\Local\Programs\Python\Python311\Lib\site-packages\mempalace`
- **Palace data dir:** `D:\AIAssist\memory\` (contains `mempalace.yaml`, `mempalace/` sub-dir, `conversations/`, etc.)
- **How to use:** CLI only — `python -m mempalace {init,mine,search,compress,wake-up,split,hook,instructions,repair,status}`
- **Listening port:** **NONE** — Mempalace is a pure CLI tool, not a daemon or server. It has no HTTP interface.
- **Health check that works today:** `python -m pip show mempalace` (exit 0 = installed)

**Current manifest check is WRONG:**
- `software-manifest.json` uses `check: { kind: "http", url: "http://127.0.0.1:8765/health" }` — this URL will never be reachable. Port 8765 is not used by Mempalace.
- **Correct check:** `pip` kind → `{ "kind": "pip", "package": "mempalace" }`. Status: `ok` if installed (pip shows it), `missing` if not. There is no "running" state to detect.

**Phase B fix path:** Replace with:
```json
{ "kind": "pip", "package": "mempalace" }
```

---

## A.4 — Graph RAG

- **Backend:** Custom-built Python + **SQLite** (NOT Microsoft GraphRAG, NOT LangChain, NOT Neo4j)
- **Source code:** `D:\AIAssist\home\graph-rag\` — bespoke implementation with modules: `graph_store.py`, `ingestion/`, `indexing/`, `retrieval/`, `reasoning/`
- **DB file:** `D:\AIAssist\memory\graph_rag.db` — SQLite, 45 KB (small; modest content)
  - Last modified: 2026-04-14
- **DB schema (from source):**
  ```
  entities(id, name, type, subject, description, embedding_json, created_at)
  relations(id, source_id, target_id, relation_type, weight, metadata_json, created_at)
  documents(id, title, source, subject, content_hash, chunk_count, created_at)
  chunks(id, doc_id, chunk_index, text, embedding_json, created_at)
  ```
- **Listening port:** **NONE** — called via `python -c "..."` subprocesses from `server.js`, not a running daemon.
- **Health check that works today:** `fs.existsSync("D:\\AIAssist\\memory\\graph_rag.db")` — exactly what `server.js`'s `getGraphRAGStatus()` already does.

**Current manifest check is WRONG:**
- `software-manifest.json` uses `check: { kind: "http", url: "http://127.0.0.1:8766/health" }` — port 8766 is never bound.
- **Correct check:** `fs` kind on the DB file.

**Phase B fix path:** Replace with:
```json
{ "kind": "fs", "paths": ["D:\\AIAssist\\memory\\graph_rag.db"] }
```

**Phase E note — subjects vs topics:**
The current schema has a hardcoded `subject` column with fixed keyword values (`technology`, `science`, `history`, `business`, `personal`, `health`, `news`, `research`, `conversation`, `tasks`, `general`). These are auto-classified by keyword matching, NOT user-created topics. Phase E's "knowledge topic" feature will need to add a proper user-defined topic system — either a new `topics` table or a `metadata_json` tag on documents. No structural change is needed for Phase B.

> ⚠️ Discovery correction — 2026-04-20
>
> Phase E.1 found that the live `graph_rag.db` does NOT have the
> `subject` column described in the original Phase A discovery.
> The source code defines it, but the ALTER TABLE migration was
> never applied against the live file. The DB is also empty
> (0 rows across all tables), so Phase E.2 can evolve the schema
> freely with no backfill. See GRAPHRAG_KB_BEST_PRACTICES.md §1.

---

## A.5 — WhatsApp Bridge

- **Root:** `D:\AIAssist\whatsapp-bridge`
- **Entry script:** `bridge.js`
- **Package name in JSON:** `whatsapp-ai-bridge` v1.0.0
- **npm library:** `whatsapp-web.js` v1.23.0 (Puppeteer-based WhatsApp Web automation)
- **PM2 name (intended):** `whatsapp-bridge` (from `package.json` scripts: `pm2 start bridge.js --name whatsapp-bridge --restart-delay 5000`)
- **Current PM2 status:** **NOT running under PM2.** `bridge.js` is not a live process.
- **How it communicates:** No outbound HTTP port — it responds to inbound WhatsApp messages via Puppeteer. The `config.json` references `dashboardPort: 7788` (to talk back to the dashboard) and `lmStudio.baseUrl: http://localhost:1234` (to forward queries).
- **Session:** `./session/` dir holds the WhatsApp Web session (LocalAuth strategy — persists login).
- **companion:** `memory-miner.js` IS already in PM2 as `memory-miner` — this runs independently of bridge.js.

**Phase C action needed:** `pm2 start D:\AIAssist\whatsapp-bridge\bridge.js --name whatsapp-bridge --cwd D:\AIAssist\whatsapp-bridge --restart-delay 5000 --max-restarts 10`

---

## A.6 — WeChat Bridge

- **Root:** `D:\AIAssist\wechat-bridge`
- **Entry script:** `bridge.js`
- **Package name in JSON:** `wechat-ai-bridge` v1.0.0
- **npm library:** `wechaty` v1.20.2 + `wechaty-puppet-wechat` v1.18.1
- **PM2 name (intended):** `wechat-bridge` (from `package.json` scripts)
- **Current PM2 status:** **NOT in PM2, not running.**
- **Issue #6 intent:** Register in PM2 but start stopped. The existing `server.js` already references `wechat-bridge` by name in `getWeChat()` — it will appear in `/api/services` once registered in PM2.

**Phase C action needed:** Register in PM2 with `autorestart: false` and immediately `pm2 stop wechat-bridge`.

---

## A.7 — Windows + PM2 startup posture

| Tool | Version |
|---|---|
| Node.js | v20.11.1 |
| npm | 10.2.4 |
| pm2 | (daemon running; CLI gives EPERM from this shell) |
| pm2-windows-startup | 1.0.3 (globally installed) |

**PM2 startup status: NOT configured for auto-boot.**

- No Task Scheduler entry matching `pm2`.
- No Windows Service matching `pm2`.
- No Startup folder entry.
- `pm2-windows-startup` v1.0.3 is installed globally but `pm2-startup install` has not been run (or was run in a context that didn't persist).
- PM2 daemon was started **manually** at `2026-04-18T10:09:54` — it will not survive a reboot.

**Phase C will need to run `pm2-startup install`** from an elevated/correct terminal context. See open questions below regarding the EPERM boundary.

**LM Studio at login:** `HKCU\Run` key `electron.app.LM Studio` → starts the GUI at logon with `--run-as-service`. This explains why the app process is running but the server is not — the GUI launches but the user hasn't clicked "Start Server."

> ⚠️ Discovery correction — 2026-05-01
>
> Two facts contradict the original Phase C / Phase A discovery:
>
> 1. `ecosystem.config.js` lives at `D:\AIAssist\ecosystem.config.js`
>    (one directory above the dashboard repo), NOT inside the
>    dashboard repo. Earlier notes implying it was inside the repo
>    were wrong.
>
> 2. Phase C did NOT in fact wire memory-miner into PM2. The
>    ecosystem.config.js created in Phase C contained only
>    ai-dashboard, whatsapp-bridge, wechat-bridge. Phase E.2-FIX
>    adds the memory-miner block. After this fix, the file contains
>    all four apps.

---

## Manifest corrections summary (Phase B input)

| Item | Current check (wrong) | Correct check |
|---|---|---|
| LM Studio | `cmd: "lms --version"` → always `ok` | `compound`: `fs` (exe path) + `http` (port 1234) |
| Ollama | `http: 127.0.0.1:11434` | **Remove entirely** (Issue #2) |
| Mempalace | `http: 127.0.0.1:8765` → never reachable | `pip: "mempalace"` |
| Graph RAG | `http: 127.0.0.1:8766` → never reachable | `fs: "D:\\AIAssist\\memory\\graph_rag.db"` |
| WhatsApp Bridge | `pm2: "whatsapp-bridge"` (not in PM2 yet) | Same, but bridge must first be registered (Phase C) |

---

## Open questions for CW

1. **LM Studio server start:** `lms server start` is a valid CLI command that starts the inference server headlessly. Should the dashboard offer a "Start LM Studio Server" button (wiring a `POST /api/lmstudio` with `action: "start"`)? This already exists in `server.js`'s `controlLMStudio()`. Or is clicking the GUI preferred?

2. **Mempalace "ok" semantics:** With a `pip` check, the status will be `ok` if the package is installed, regardless of whether any palace has been initialised at `D:\AIAssist\memory`. Is that the right pass/fail bar? Alternative: also check `fs.existsSync("D:\\AIAssist\\memory\\mempalace.yaml")` as a compound check to confirm the palace is initialised.

3. **Graph RAG db check:** The `fs` check on `graph_rag.db` means status is `ok` if the file exists, even if it's empty or corrupt. Should we additionally do a quick SQLite query (the existing `getGraphRAGStatus()` already does this) and report `degraded` if the schema is wrong? Or is file-exists good enough for the manifest panel?

4. **WhatsApp Bridge — start now or Phase C only?** `bridge.js` is not currently running. Phase C will register it in PM2. Do you want the bridge started immediately as part of Phase C, or should it stay stopped until you explicitly start it (to avoid unexpected WhatsApp activity during testing)?

5. **PM2 EPERM / startup setup:** `pm2-startup install` and `pm2 save` must be run from the same terminal session that owns the PM2 daemon (not from Claude Code's bash shell). For Phase C, I'll prepare the exact commands; you'll need to paste and run them in your own terminal. Alternatively: should we try `pm2-startup install` from Claude Code via `Start-Process` with `-Verb RunAs` (requires UAC prompt)? Please confirm your preferred approach.

6. **Phase E topics vs current subjects:** The Graph RAG schema has a hardcoded `subject` column (keyword-classified). Phase E needs user-defined, persistent topics. The cleanest approach is a new `topics` table in `graph_rag.db` + a `document_topics` join table, plus migrating existing `subject` values to seed the new table. This is ~30 lines of Python. Shall we include this in Phase E, or keep the schema strictly additive (new table only, old `subject` column untouched)?
