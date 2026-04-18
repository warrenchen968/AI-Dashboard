# Phase B — Open Question Decisions

Answers to the 6 open questions from DISCOVERY.md. Written before any code was
changed; all confidence levels are medium or high so Phase B proceeds without
blocking.

---

## Q1. LM Studio server start: should the dashboard offer a "Start LM Studio Server" button?

**Decision:** No new button in Phase B. The `degraded` status + detail text
"installed, server not started" communicates the state clearly. The
`controlLMStudio()` function already exists in `server.js` — wiring it into a
UI Start button is Phase D work (ROUND2_PLAN.md D.1 explicitly covers service
control surface).

**Reason:** Phase B scope is detection only. Adding a control button here would
pull in Phase D UI work prematurely and bloat the diff.

**Confidence:** high

---

## Q2. Mempalace "ok" semantics: pip-only vs compound pip+fs(mempalace.yaml)?

**Decision:** pip-only check (`python -m pip show mempalace`). Status `ok` = package
installed. We do NOT additionally verify `D:\AIAssist\memory\mempalace.yaml`.

**Reason:** PHASE_B_DRAFT.md explicitly states "pip show alone is enough for
'is it installed'." The palace data dir is a runtime concern, not an
installation concern. A second fs check adds complexity for little value at this
stage.

**Confidence:** medium

**If low, what would make it high:** CW explicitly stating that "Mempalace ok"
should mean "palace initialized and ready to use", not just "package installed".

---

## Q3. Graph RAG db check: file-exists only vs file-exists + SQLite schema query?

**Decision:** File-exists only (`fs.existsSync("D:\\AIAssist\\memory\\graph_rag.db")`).
No SQLite schema query in the manifest check.

**Reason:** The manifest panel is a presence indicator, not a deep health probe.
The existing `getGraphRAGStatus()` in server.js already does a full SQLite
query for the `/api/graphrag/stats` endpoint — that is the right place for
structural validation. Duplicating that logic in the manifest check adds noise.

**Confidence:** medium

**If low, what would make it high:** CW confirming they want the Principle #9
panel to distinguish "DB exists but schema broken" from "DB healthy".

---

## Q4. WhatsApp Bridge — start now or Phase C only?

**Decision:** Phase C only. Phase B makes no changes to the WhatsApp Bridge
entry in `software-manifest.json` (it stays as `pm2: "whatsapp-bridge"`).
Starting the bridge is Phase C work.

**Reason:** Phase B scope is detection rewrite only. Starting a WhatsApp bridge
mid-phase would introduce unexpected WhatsApp activity and PM2 state changes
that could confuse verification.

**Confidence:** high

---

## Q5. PM2 EPERM / startup: use Start-Process with RunAs vs CW pastes commands?

**Decision:** CW pastes commands in their own terminal. Claude Code does NOT
attempt `Start-Process -Verb RunAs`. If `pm2 restart ai-dashboard` is blocked
by EPERM in Step 5, skip it and report — CW restarts from their terminal.

**Reason:** DISCOVERY.md explicitly documents the EPERM boundary (PM2 daemon
started from a different terminal session). `Start-Process -Verb RunAs` requires
UAC and may silently fail in a non-interactive context. The safer path is
documented manual steps.

**Confidence:** high

---

## Q6. Phase E topics vs current subjects: new tables only vs migrate existing subject values?

**Decision:** Keep schema strictly additive: new `topics` + `document_topics`
tables only. Old `subject` column is untouched. Existing subject values are NOT
migrated automatically.

**Reason:** Touching the existing `subject` column risks breaking the current
`/api/graphrag/subjects` endpoint and the keyword-classification logic, both of
which are live and tested. Adding new tables is zero-risk and fully reversible.
Subject → topic migration can be a deliberate CW action in Phase E, not an
automatic migration.

**Confidence:** high

---

*All 6 decisions: medium or high confidence. No blockers. Proceeding to Step 3.*
