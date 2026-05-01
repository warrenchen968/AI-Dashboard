# Round 2 Retrospective

> Date closed: 2026-05-01
> Branch: phase-d merged to main at round-2-shipped tag.

---

## Shipped

| Phase | Commit | Description |
|-------|--------|-------------|
| A -- Discovery | pre-existing main | Empirical inventory of all services; produced DISCOVERY.md |
| B -- Detection rewrite | `438300d` | Rewrote software-manifest.json + principle9-routes.js: compound/fs/pip checks, LM Studio degraded state, Mempalace pip check, Graph RAG fs check, Ollama removed |
| C -- Service control | `8024ba6` | Registered whatsapp-bridge + wechat-bridge in PM2; start/stop endpoints; services-external.js for non-PM2 entries |
| D -- Services page enrichment | `8024ba6` | LM Studio model list, loaded-model flag, controllable:false for external services |
| E.1 -- Graph RAG best practices | `7398010` | GRAPHRAG_KB_BEST_PRACTICES.md research write-up; approved by CW |
| E.2 -- Graph RAG topics API | `33b14e7` | New graphrag-routes.js: GET/POST /api/graphrag/topics, ingest-text, ingest-file; topics.py + migrations.py in graphrag-personal repo |
| E.2-FIX -- pyRun + escaping | `7004869` | Rewrote pyRun to use temp file (not -c "..."); fixed ingest-text/file escaping; tightened 2 skip-stubs; memory-miner added to ecosystem.config.js |
| G.4 -- graphrag-personal repo | `7398010` | Initialised private GitHub repo warrenchen968/graphrag-personal; tagged v0.0.1-import; 15 Python source files committed |

---

## Issues closed (10 of 10)

1. **LM Studio shows "missing" on software manifest** -- Phase B + D (`438300d`, `8024ba6`). Compound fs+http check replaces the broken `lms --version` cmd check. Phase D added model list + loaded-model field.

2. **Remove Ollama entirely** -- Phase B (`438300d`). Entry deleted from software-manifest.json.

3. **Mempalace shows "missing"** -- Phase B (`438300d`). Switched to `pip: mempalace` check; status is ok when package installed.

4. **Graph RAG shows "missing"** -- Phase B (`438300d`). Switched to `fs: graph_rag.db` check; status is ok when DB file exists.

5. **WhatsApp Bridge -- Windows startup service + dashboard control** -- Phase C/D (`8024ba6`). bridge.js registered in PM2 as whatsapp-bridge; start/stop endpoints wired; ecosystem.config.js created.

6. **Pause WeChat Bridge** -- Phase C/D (`8024ba6`). wechat-bridge registered in PM2 with autorestart:false; starts stopped.

7. **Graph RAG knowledge-topic UX** -- Phase E.1 + E.2 + E.2-FIX (`7398010`, `33b14e7`, `7004869`). Research write-up approved; topics CRUD API and ingest endpoints shipped; pyRun bug fixed so endpoints actually work.

8. **Services page: LM Studio status + model list + loaded model** -- Phase D (`8024ba6`). /api/services extended with kind:external, extras.models[], loadedModelId.

9. **Services page: WhatsApp Bridge on/off control** -- Phase C/D (`8024ba6`). PM2 registration + start/stop endpoint + controllable:true.

10. **Services page: WeChat Bridge default-off control** -- Phase C/D (`8024ba6`). PM2 registration stopped-by-default + controllable:true.

---

## Discovery corrections

- **(a) graph_rag.db lacked subject column.** Phase A discovery documented the subject column in the entities/documents schema. Phase E.1 found the live DB had never received the ALTER TABLE migration. DB was also empty (0 rows). Phase E.2 evolved the schema freely with no backfill. See GRAPHRAG_KB_BEST_PRACTICES.md section 1 and DISCOVERY.md correction dated 2026-04-20.

- **(b) ecosystem.config.js lives at D:\\AIAssist\\ not inside the dashboard repo.** Earlier notes implied it lived alongside server.js. Actual path is one level up: D:\\AIAssist\\ecosystem.config.js. See DISCOVERY.md correction dated 2026-05-01.

- **(c) Phase C did not wire memory-miner into PM2.** The Phase C project-memory note claiming memory-miner was added was wrong; the ecosystem.config.js at that point had only ai-dashboard, whatsapp-bridge, wechat-bridge. Phase E.2-FIX (`7004869`) added the memory-miner block. After this fix the file contains all four apps.

---

## Bugs found late and how they were caught

- **pyRun cmd.exe newline truncation** -- The original pyRun joined script lines with \\n and ran `python -c "..."`. On Windows, cmd.exe ends a double-quoted argument at the first embedded newline, so Python silently executed only `import sys, json` and returned empty stdout. `JSON.parse('')` threw "Unexpected end of JSON input" and the route returned 500. *Caught by CW's manual smoke run on the live server after E.2 shipped.* Verified by running the same script joined with `;` and getting valid JSON. Fixed in E.2-FIX by writing script to a temp .py file.

- **Escaping in ingest-text and ingest-file** -- The route builders applied shell-level quote escaping (`replace(/"/g, '\\"')`) to values destined for the Python temp file. In a Python source file, `\"` at the start of an expression is a `SyntaxError: unexpected character after line continuation character`. *Caught during E.2-FIX code review when comparing temp-file output to expected Python syntax.* Fixed by using `JSON.stringify(value)` directly -- it produces valid Python string literals without additional escaping.

- **smoke_test.js stub did not expose `{stdout, stderr}` shape** -- The exec stub replaced `cp.exec` but did not carry over `util.promisify.custom`. So `execAsync = promisify(stub)` used standard node-style promisify (resolves with the first non-error arg, just `stdout` as a string). Route code then destructured `{ stdout }` from a string, getting `undefined`, and `stdout.trim()` threw TypeError. *Caught when tightening skip-stubs during E.2-FIX.* Fixed by adding `cp.exec[promisify.custom]` that routes graphrag-*.py calls to `_realExecAsync` (which correctly resolves `{stdout,stderr}`).

---

## Operational lessons

- **Split-execution model is now standard.** Claude Code prepares PS1 scripts; CW runs all PM2 mutations and git pushes in his own elevated PowerShell. This avoids the EPERM barrier and keeps CW in control of destructive operations. Every future phase should produce a `phase-X-commands.ps1`.

- **PS1 files must be ASCII-only.** UTF-8 em-dashes, box-drawing characters, and smart quotes all become mojibake on machines where the Windows console code page is Windows-1252 (cp 1252). This breaks PS1 parsing mid-script. Rule: write PS1 with ASCII only, or save with explicit UTF-8 BOM. Lesson applied in Phase F retroactively to phase-e2-commands.ps1 and phase-e2-fix-commands.ps1.

- **"Already applied" reports can misrepresent session work.** A fresh-context Claude Code session may read a file that was modified in a previous session and report its own prior changes as "already done". Verification must be behavioural (run the smoke suite, hit the endpoint) not just file-state comparison.

---

## Round 3 candidates (deferred)

- **Phase G.1** -- whatsapp-local-llm-bridge: public GitHub repo init for the WhatsApp bridge codebase.
- **Phase G.2** -- wechat-local-llm-bridge: public GitHub repo init for the WeChat bridge codebase.
- **Phase G.3** -- mempalace-personal: private GitHub repo init for the Mempalace installation.
- **phase-d branch retirement** -- delete local + remote phase-d after confirming main is stable.
- **Auth / localhost hardening** -- needed before Mac mini migration (planned May 2026).
- **Graph RAG backup endpoint** -- periodic snapshots of graph_rag.db.

---

## Numbers

| Metric | Before Round 2 | After Round 2 |
|--------|----------------|---------------|
| Smoke tests passing | 9 | 24 |
| Skip-stubs | 0 | 0 (2 added in E.2, removed in E.2-FIX) |
| PM2 managed apps | 1 (ai-dashboard) | 4 (+whatsapp-bridge, wechat-bridge, memory-miner) |
| Commits added on phase-d | -- | 3 (7398010, 33b14e7, 7004869) |
| New private repo | -- | graphrag-personal (15 files, tag v0.0.1-import) |
| Issues closed | 0 / 10 | 10 / 10 |
| Files added to dashboard repo | -- | ecosystem.config.js*, graphrag-routes.js, services-external.js, DISCOVERY.md, CONTRACTS.md, GRAPHRAG_KB_BEST_PRACTICES.md, PHASE_B_DECISIONS.md, PHASE_D_DISCOVERY.md, ROUND2_RETRO.md |

*ecosystem.config.js lives at D:\\AIAssist\\ (one level above dashboard repo).
