# Graph RAG Knowledge-Base Best Practices
## Phase E.1 Research Write-Up — AI-Dashboard, 2026-04-20

> **Scope:** Research only. No production code is changed in this phase.
> **Audience:** CW — entrepreneur, daily driver of this system, bilingual (EN/中文),
> moving from Windows laptop to Mac mini in May 2026.
> **Stop condition:** CW reads this, strikes through the MUST/SHOULD/NICE list in
> Section 8, and gives the green-light. Phase E.2 starts after that.

---

## ⚠️ Discovery Correction

**DISCOVERY.md's description of the Graph RAG schema is partially wrong.**

DISCOVERY.md (A.4) states the schema includes a `subject` column on both `entities`
and `documents`. The source code at `D:/AIAssist/home/graph-rag/graph_store.py` does
define that column in its `CREATE TABLE` and migration statements. **However, the
actual SQLite file at `D:/AIAssist/memory/graph_rag.db` does NOT have the `subject`
column in any table.**

The database was created by an older version of `graph_store.py` — before the
`subject` column was added — and the `ALTER TABLE` migration in the current source
code was never applied (because importing the module requires the server to call
into Python, which has not happened against this DB yet).

**What this means for Phase E:** The "subjects" feature that DISCOVERY.md describes
(11 hardcoded keyword-classified values) does not exist in the live database at all.
We are starting from a clean, empty DB with a simpler schema. This is actually
*better* news: there is zero migration risk, zero backfill needed, and we can evolve
the schema freely.

**The Phase A assumption to update in memory:**
> "entities and documents already have a subject column" → WRONG.
> The live DB has no subject column and 0 rows in all tables.

---

# 1. Current GraphRAG State on This Machine

## 1.1 Database file

| Property | Value |
|---|---|
| Path | `D:/AIAssist/memory/graph_rag.db` |
| Size on disk | 45 KB |
| Last modified | 2026-04-14 |
| Backend | SQLite (WAL mode via `PRAGMA journal_mode=WAL`) |
| Library | Bespoke Python — NOT Microsoft GraphRAG, NOT LangChain, NOT Neo4j |
| Source root | `D:/AIAssist/home/graph-rag/` |

## 1.2 Actual schema (as it exists in the DB right now)

```sql
CREATE TABLE entities (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT    NOT NULL,
    type           TEXT    NOT NULL DEFAULT 'concept',
    description    TEXT    DEFAULT '',
    embedding_json TEXT    DEFAULT NULL,
    created_at     TEXT    NOT NULL
);
-- Indexes: idx_entity_name UNIQUE(name)
-- NOTE: no subject column despite source code defining one

CREATE TABLE relations (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id      INTEGER NOT NULL REFERENCES entities(id),
    target_id      INTEGER NOT NULL REFERENCES entities(id),
    relation_type  TEXT    NOT NULL,
    weight         REAL    NOT NULL DEFAULT 1.0,
    metadata_json  TEXT    DEFAULT '{}',
    created_at     TEXT    NOT NULL
);
-- Indexes: idx_rel_source(source_id), idx_rel_target(target_id)

CREATE TABLE documents (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    title         TEXT    NOT NULL,
    source        TEXT    NOT NULL DEFAULT '',
    content_hash  TEXT    NOT NULL,
    chunk_count   INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL
);
-- Indexes: idx_doc_hash UNIQUE(content_hash)
-- NOTE: no subject column despite source code defining one

CREATE TABLE chunks (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id         INTEGER NOT NULL REFERENCES documents(id),
    chunk_index    INTEGER NOT NULL,
    text           TEXT    NOT NULL,
    embedding_json TEXT    DEFAULT NULL,
    created_at     TEXT    NOT NULL
);
-- Indexes: idx_chunk_doc(doc_id)
```

## 1.3 Row counts (all zero — fresh / unused DB)

| Table | Rows |
|---|---|
| entities | **0** |
| relations | **0** |
| documents | **0** |
| chunks | **0** |

The database exists and its schema is valid, but no content has ever been ingested.
This is equivalent to a clean install. Any schema additions Phase E makes are purely
additive — there is nothing to migrate, backfill, or risk losing.

## 1.4 Source modules

| File | Purpose |
|---|---|
| `graph_store.py` | Core CRUD, schema init, subject classification, graph traversal |
| `ingestion/ingest.py` | Text chunking + document entry point; callers: CLI, WhatsApp bridge |
| `indexing/extractor.py` | LM Studio extraction (with rule-based fallback); extracts entities + relations from chunks |
| `retrieval/retriever.py` | Search + context assembly for RAG queries |
| `reasoning/reasoner.py` | Query → answer via graph context |
| `cli.py` | CLI wrapper for all the above (status / ingest / index / search / reason / entity) |

## 1.5 Current ingestion entry point

The primary function that accepts new content today is:

```python
# ingestion/ingest.py
def ingest_text(
    title: str,
    content: str,
    source: str = '',          # URL, file path, "whatsapp:<phone>", or empty
    subject: Optional[str] = None,   # NOT in the live DB schema — ignored today
) -> dict:
    ...
```

**Callers today:**
- `ingest_file(file_path)` — reads a file, calls `ingest_text` without a topic
- `ingest_conversation(phone, user_msg, assistant_msg, model)` — WhatsApp bridge
- CLI: `python -c "from home.graph_rag.ingestion.ingest import ingest_text; ..."` (subprocess from server.js)

**Important:** the `subject` parameter in `ingest_text` references `classify_subject()`
inside `graph_store.py` — but since the `subject` column doesn't exist in the live DB,
this parameter has no effect today. Phase E adds a real topics system in its place.

## 1.6 The "subject" system — what it was supposed to be vs. what exists

The source code defines 11 hardcoded subjects (`technology`, `science`, `history`,
`business`, `personal`, `health`, `news`, `research`, `conversation`, `tasks`,
`general`) classified by keyword matching. **This is auto-classification, not
user-controlled.** It is also non-functional in the live DB (column never applied).

Phase E replaces this concept with user-defined, persistent **knowledge topics
(知识主题)** that CW explicitly assigns at ingest time. The keyword-classification
fallback can remain as a *suggested default* on the ingest form, but the user always
has final say.

---

# 2. What "Knowledge Topic" Means in a Graph Knowledge Base

## 2.1 Definition

A knowledge topic (知识主题) is a named partition (命名分区) or namespace (命名空间)
that groups related documents, entities, and relations together. Think of it as a
folder at the top of the knowledge graph — except that unlike a file-system folder, a
single item can belong to *multiple* topics at once (N:M).

In practical terms: every document you ingest is tagged with one or more topics, and
every entity and relation extracted from that document inherits those tags. When you
query the graph, you can ask "search only within topic X" and the retriever restricts
itself to that slice of the graph.

## 2.2 Why the topic partition is the #1 structural decision

Without topics, a growing knowledge base becomes a single undifferentiated graph.
Every query has to compete against everything you've ever ingested. That sounds
harmless at 10 documents, but it compounds badly:

- A question about a business deal starts pulling in personal health notes.
- A question about a software architecture starts mixing in historical reading.
- Entity de-duplication becomes harder because the same name can appear with
  completely different meaning in different domains.
- Retrieval context windows fill up with off-topic facts, degrading LLM answer quality.

Topics fix all of these by giving the retriever a **scope boundary** before it starts
traversal. The implementation cost is low (one JOIN table), and the payoff compounds
with every document added.

## 2.3 Concrete before/after illustration

**Scenario:** CW asks: "What do I know about my marketing strategy for Product X?"

**Without topics (flat graph, 200 documents ingested):**

Retrieved context sent to LLM:
```
Entity: Product X        → relation: mentioned_in → document: personal-journal-2026-03.md
Entity: Product X        → relation: related_to   → entity: Competitor Y (from news article)
Entity: Marketing        → relation: includes      → entity: Social Media (from tech notes)
Entity: Strategy         → relation: defined_in    → entity: Sun Tzu (from history book)
Entity: Product X        → relation: has_issue     → entity: Login Bug (from dev task list)
```
The LLM receives a mix of personal diary, news, tech notes, ancient history, and dev
tasks. It cannot construct a useful answer because the context is incoherent.

**With topics (same 200 documents, topic "Business > Product X Marketing" assigned
at ingest):**

Retrieved context sent to LLM:
```
[Topic: Business / Marketing]
Entity: Product X        → relation: targets       → entity: SMB Segment
Entity: Product X        → relation: uses_channel  → entity: LinkedIn Ads
Entity: Marketing Budget → relation: allocated_to  → entity: Q2 Campaign
Entity: Q2 Campaign      → relation: linked_to     → entity: Product X Launch
```
The LLM receives a clean slice of the graph. It can reason coherently and cite sources.

The delta in answer quality is not subtle — it is the difference between a useful
knowledge base and a heap of facts.

## 2.4 Alternative approaches and why they underperform

**Option A — flat graph + filter by source URL:**
Works for "show me what came from this one document." Breaks down when you have 50
documents and want to scope to a theme that spans several of them.

**Option B — one SQLite database per domain:**
Simple to implement. Creates data silos: cross-domain queries become impossible.
Entities shared across domains (e.g., "CW" as a person appears in both business and
personal notes) cannot be linked. Backup and migration become multiple files.

**Option C — metadata tag on each document (no dedicated table):**
Storing topics as a comma-separated string inside `documents.metadata_json` avoids a
JOIN table. Fast to implement, but hard to rename a topic, hard to list all topics,
and hard to count items per topic. Works at 5 topics; fails at 30+.

**Option D — the proposed approach (topics table + N:M join):**
Three new rows in three new tables for every ingested document. Query cost is one JOIN.
Topics are renameable, countable, and deletable with cascade. This is the right choice
for a knowledge base that will grow for years.

---

# 3. Best-Practice Dimensions — Ranked for CW's Deployment

Ranking criteria: **value to CW right now** (single user, single laptop, ~0 rows
today, bilingual, migrating to Mac mini in May 2026) divided by **cost to implement
and maintain**. Rank 1 = highest value-for-cost.

| # | Dimension | What it is | Why it matters | Implementation cost | Rank |
|---|---|---|---|---|---|
| 1 | **Knowledge topics (知识主题)** | Named partitions; user-assigned at ingest | Without it, retrieval blends everything; #1 structural choice | Low: 2 new tables + 1 column on documents | **1** |
| 2 | **Source provenance (来源溯源)** | URL / filepath / paste-timestamp on every doc | Lets CW ask "why does the graph know this?" and re-verify | Trivially low: `source` column already exists in `documents` | **2** |
| 3 | **Search (搜索)** | Keyword + filtered graph traversal | Useless knowledge base without it | Low: already partly implemented in `retriever.py` | **3** |
| 4 | **Curation / extraction preview (抽取预览)** | Show extracted entities + relations before committing | Catches LLM extraction errors before they pollute the graph | Medium: needs a "dry-run" mode in the extractor | **4** |
| 5 | **Entity/relation schema (实体关系模式)** | Named types: Person, Company, Concept, Event, Technology | Improves retrieval precision; avoids "John Smith" ambiguity | Low: `type` column already on entities; just enforce a vocabulary | **5** |
| 6 | **Entity de-duplication (实体去重)** | Merging "CW", "Warren", "X's founder" into one node | Without it, the same person grows as disconnected islands | High: requires similarity matching or manual merge UI | **6** |
| 7 | **Export / backup (导出备份)** | Periodic SQLite snapshot to a dated file | Boring but critical; one corrupted DB file = lost knowledge | Very low: single `cp` command or one endpoint | **7** |
| 8 | **Versioning (版本控制)** | Track when a fact was added, superseded, contradicted | Important for time-sensitive domains (market data, health) | High: requires `superseded_by` links or event-log table | **8** |
| 9 | **Confidence / quality scoring (置信度评分)** | System-assigned score per fact; user can downvote | Useful at scale; overkill at 0 rows today | Medium: float column + UI controls | **9** |
| 10 | **Hierarchical topics (层级主题)** | `Business > Marketing > Strategy` | Useful at 50+ topics; friction before then | Medium: `parent_id` FK on topics table | **10** |
| 11 | **Bilingual entity alignment (中英文实体对齐)** | Linking "人工智能" to "Artificial Intelligence" as one node | Important for cross-language queries | High: requires normalization layer or alias table | **11** |
| 12 | **Access control (访问控制)** | Per-user or per-topic permissions | Irrelevant while single-user + localhost | N/A: defer until multi-user | — |

**Notes on ranking:**

Ranks 1–3 are must-haves that make the knowledge base functional at all. Everything
from rank 6 down is deferred; they add value but are not needed to ship a working
Graph RAG UI.

Bilingual alignment (rank 11) is intentionally low because CW ingests predominantly
English documents today. When Chinese-language content grows, an alias table
(`entity_aliases` with `language` + `normalized_name`) can be added without touching
the core schema.

---

# 4. Direct Answer to CW's Upload-Topic Question

> **CW's question:** "When users upload files, should we REQUIRE them to pick a
> knowledge topic?"

## Answer: YES — the topic field must be required, not optional.

Here are the three concrete failure modes that arise if the topic field is optional:

### Failure Mode A — Users skip it and the graph becomes a single bucket

Human nature: if a field is optional, users skip it under time pressure.
After 6 months of uploads without topic assignment, you have 500 documents and
zero ability to scope retrieval. Every query returns a blend of everything.
You cannot fix this retroactively without reading every document again.

### Failure Mode B — Retroactive topic assignment is expensive

If topics are optional and CW decides to add them later, the work required is:
1. Read every `documents` row (potentially hundreds).
2. Manually assign a topic to each.
3. Propagate the topic down to every entity and relation extracted from that document.

Step 3 is the expensive part: entities don't know which document they came from
unless you traverse the `chunks → documents` path. This JOIN-and-update query
is safe but tedious, and it must be done before topic-scoped search works.
Making topics required at ingest time costs 2 seconds per upload and saves hours
of retroactive work.

### Failure Mode C — Source provenance alone doesn't solve scoping

Some teams try to substitute "filter by source URL" for topic partitioning.
This works for "show me what came from *this URL*" — but it does not answer
"show me everything I know about *this theme*." Themes span multiple sources.
Source provenance and knowledge topics are complementary, not substitutes.

## Mitigation for the friction of required topics

Making a field required is a UX tax. Reduce it three ways:

1. **Create-on-the-fly:** The topic picker on the ingest form allows typing a new
   topic name and hitting Enter — no separate "create topic first" step required.

2. **Multiple topics per upload:** A single document can belong to more than one
   topic. CW uploads a business plan → assigns both "Business" and "Product X".

3. **Seed a starter set at first run:** Before CW has thought through a taxonomy,
   the system pre-creates five starter topics:
   - `General` (默认主题 — the catch-all for anything that doesn't fit elsewhere)
   - `Business` (商业)
   - `Personal` (个人)
   - `Technology` (技术)
   - `Research` (研究)

   These are wide enough to be useful on day one, narrow enough to be worth having.
   CW can rename or add to them at any time.

---

# 5. Schema Proposal Against the Actual SQLite Backend

This is a proposal only. No DDL is executed in Phase E.1.

## 5.1 Starting point — actual live schema

The live DB has the four tables listed in Section 1.2. No `subject` column exists.
All counts are zero.

## 5.2 Additive migrations required for Phase E.2

All of the following are **additive** (CREATE TABLE / ADD COLUMN). Nothing is dropped
or altered destructively. Because the DB is empty, there is no backfill needed.

```sql
-- ── Migration E2-01: topics table ────────────────────────────────────────────
-- One row per user-defined knowledge topic.
CREATE TABLE IF NOT EXISTS topics (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    description TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_topic_name ON topics(name);

-- Seed default topics (run once at migration time, not on every startup)
INSERT OR IGNORE INTO topics(name, created_at) VALUES
  ('General',    datetime('now')),
  ('Business',   datetime('now')),
  ('Personal',   datetime('now')),
  ('Technology', datetime('now')),
  ('Research',   datetime('now'));

-- ── Migration E2-02: source_topics join table ─────────────────────────────────
-- N:M between documents and topics.
-- This is the authoritative topic tag — lives at the document level.
CREATE TABLE IF NOT EXISTS source_topics (
    doc_id   INTEGER NOT NULL REFERENCES documents(id)  ON DELETE CASCADE,
    topic_id INTEGER NOT NULL REFERENCES topics(id)     ON DELETE RESTRICT,
    PRIMARY KEY (doc_id, topic_id)
);
CREATE INDEX IF NOT EXISTS idx_st_topic ON source_topics(topic_id);

-- ── Migration E2-03: entity_topics join table (optional — see note below) ────
-- Propagates topic membership from document → entity.
-- DECISION: this table is NOT in the MUST slice — see Section 5.3.
-- Included here for completeness; mark as NICE in E.2.
-- CREATE TABLE IF NOT EXISTS entity_topics (
--     entity_id INTEGER NOT NULL REFERENCES entities(id)  ON DELETE CASCADE,
--     topic_id  INTEGER NOT NULL REFERENCES topics(id)    ON DELETE RESTRICT,
--     PRIMARY KEY (entity_id, topic_id)
-- );

-- ── Migration E2-04: notes column on documents ────────────────────────────────
-- Free-text provenance note set by user at ingest time.
ALTER TABLE documents ADD COLUMN notes TEXT NOT NULL DEFAULT '';
```

## 5.3 Should we propagate topics to the entity level?

This is a trade-off question worth understanding before implementing.

**Option A — topic lives only on `source_topics` (document level):**
- Simple: one join table, one cascade.
- To search entities within a topic, you join:
  `entities → relations → documents via chunks → source_topics`
  This is a 3-hop join but SQLite handles it fine at our scale.
- Renaming a topic takes one UPDATE in `topics`. Done.
- **Recommended for Phase E.2.**

**Option B — topic propagated to `entity_topics` as well:**
- Faster entity-scoped queries (one join instead of three).
- Adds complexity: entity topic tags must be kept in sync when a document is
  deleted or re-tagged. At 0 rows today, the sync logic is trivial to add —
  but it's still an invariant to maintain forever.
- Useful when the entity count grows past ~10,000 and query performance
  becomes measurable. Not useful today.
- **Defer to Phase E.3 if query latency becomes a concern.**

**Decision for E.2:** implement `source_topics` only (Option A). Add `entity_topics`
in a future phase if benchmark shows it's needed.

## 5.4 Backfill strategy

Because the DB is empty (0 rows), there is no backfill needed. If the DB were
populated (future scenario, e.g., after first real use), the backfill strategy would
be: assign all existing documents to the `__unclassified` synthetic topic, which CW
can then retag through the Browse UI.

For reference, the backfill SQL would be:
```sql
-- (Do NOT run now — only relevant if documents already exist)
INSERT OR IGNORE INTO topics(name, created_at) VALUES ('__unclassified', datetime('now'));
INSERT OR IGNORE INTO source_topics(doc_id, topic_id)
  SELECT d.id, t.id FROM documents d
  CROSS JOIN topics t WHERE t.name = '__unclassified';
```

## 5.5 Subject column — what to do with graph_store.py

The source code in `graph_store.py` defines a `subject` column and auto-classification
logic. **Leave it in place for now.** Do not delete or rewrite `classify_subject()`.
Instead, in Phase E.2, treat the `subject` column as an internal auto-tag (useful
for debugging extraction) and treat user-defined topics as the primary partitioning
mechanism. They complement each other: topics are explicit (user intent), subjects
are implicit (content signal). In a future phase, the auto-classified subject could
seed the topic-picker suggestion on the ingest form ("we think this is a Technology
document — confirm?").

When `init_db()` next runs (i.e., when the Python module is imported by the server),
it will apply the `ALTER TABLE` migration that adds the `subject` column to the live
DB. That migration is safe (additive, has a DEFAULT). Phase E.2 should call
`init_db()` explicitly during startup to ensure the subject column exists before
any queries reference it.

---

# 6. API Surface (Proposal for Phase E.2)

The endpoint list below comes directly from ROUND2_PLAN.md §E.2.a, annotated with
implementation notes and which ones CW can drop for a smaller initial slice.

### 6.1 Topics CRUD

```
GET    /api/graphrag/topics
POST   /api/graphrag/topics
DELETE /api/graphrag/topics/:name
```

**GET /api/graphrag/topics**
Returns the full topic list with item counts.
```json
{ "topics": [
  { "id": 1, "name": "General",    "count": 12, "createdAt": "2026-04-20T..." },
  { "id": 2, "name": "Business",   "count": 8,  "createdAt": "2026-04-20T..." }
]}
```
Implementation: `SELECT t.name, COUNT(st.doc_id) AS count FROM topics t LEFT JOIN source_topics st ON st.topic_id = t.id GROUP BY t.id`. One query.

**POST /api/graphrag/topics** — body `{ "name": "New Topic" }`
Returns 201 on success, 409 if name already exists.
Implementation: `INSERT OR FAIL INTO topics(name, created_at) VALUES(?, ?)`.

**DELETE /api/graphrag/topics/:name**
Returns 200. Refuses deletion if any `source_topics` row still references this topic
(prevents orphaned documents), unless `?force=true` is passed (which re-assigns those
documents to "General").
Implementation: check `source_topics` count; either error or cascade-reassign.

> **CW can drop:** DELETE. Topics CRUD without deletion is a valid Phase E.2 slice.
> Add DELETE in E.3 once the Browse UI makes it clear which topics have content.

### 6.2 Ingest endpoints

```
POST /api/graphrag/ingest-url    body { url, topics: [string], notes? }
POST /api/graphrag/ingest-file   multipart: file, topics[], notes
POST /api/graphrag/ingest-text   body { text, topics: [string], notes? }
```

All three return `{ "jobId": "...", "docId": N, "chunks": N, "topics": [...] }` on
success, or `400 { "error": "topics_required" }` if `topics` is empty or missing.

Implementation: each endpoint validates `topics.length >= 1`, calls the existing
`ingest_text` / `ingest_file` Python subprocess (or a direct Node `child_process`
call), then writes the `source_topics` rows in Node after getting back the `doc_id`.

For `ingest-url`: fetch the URL content server-side (using `node-fetch` or the
existing `axios`/`fetch` already in `server.js`), then pass the text to `ingest_text`.

For `ingest-file`: receive via `multer` (already used in `server.js` for other
uploads), write to a temp file, call `ingest_file`.

> **CW can drop:** `ingest-url` in the first slice if URL fetching adds complexity.
> `ingest-text` is the simplest and most universally useful — start there.

### 6.3 Sources list and detail

```
GET    /api/graphrag/sources?topic=X     paginated list of ingested documents
GET    /api/graphrag/sources/:id         full detail: entities, relations, topic tags
DELETE /api/graphrag/sources/:id         cascade-delete entities only from this source
```

**GET /api/graphrag/sources?topic=X**
```json
{ "sources": [
  { "id": 1, "title": "Q2 Strategy.md", "source": "file://...",
    "notes": "Uploaded 2026-04-20", "topics": ["Business"], "chunks": 14,
    "createdAt": "2026-04-20T..." }
], "total": 1, "page": 1 }
```
Implementation: JOIN `documents → source_topics → topics`, filter by topic name.

**GET /api/graphrag/sources/:id**
Returns the document's extracted entities and relations (via chunks → extractor join),
source provenance, and topic tags. Useful for "what did the graph learn from this file?"

**DELETE /api/graphrag/sources/:id**
Removes the document row and its chunks. Entities extracted from *only* this document
are also removed. Entities shared with other documents are kept (via a "dangling check"
query). This is the correct cascade behavior for a shared graph.

> **CW can drop:** DELETE /sources/:id in Phase E.2. Sources list (GET) alone is
> sufficient for the Browse tab. Add delete in E.3 once CW has confirmed entity-
> cascade behavior matches expectations.

### 6.4 Search

```
GET /api/graphrag/search?q=X&topic=Y
```

Returns entities matching the query, optionally restricted to one topic.
```json
{ "entities": [
  { "id": 7, "name": "Q2 Campaign", "type": "concept",
    "description": "...", "topics": ["Business", "Marketing"] }
], "chunks": [
  { "text": "The Q2 campaign targets...", "source": "Q2 Strategy.md" }
]}
```
Implementation: call `search_entities(q, subject=None)` + `search_chunks(q)` from
the existing `graph_store.py`, filtered via a `source_topics` join for the topic
parameter. No new Python code needed for basic search — just add the topic filter.

---

# 7. UI Surface (Proposal)

## 7.1 Two sub-tabs inside the Graph RAG page

```
┌─────────────────────────────────────────────────────────────┐
│  Graph RAG                                    [Browse] [Ingest] │
├─────────────────────────────────────────────────────────────┤
│                    (sub-tab content below)                   │
└─────────────────────────────────────────────────────────────┘
```

## 7.2 Browse tab (default)

```
┌──────────────┬──────────────────────────────────────────────┐
│ Topics       │  Business (8 docs)                            │
│              │                                               │
│ • General 12 │  🔍 Search within topic: [___________]        │
│ ▶ Business 8 │                                               │
│ • Personal 3 │  Sources                    Entities           │
│ • Technology │  ─────────────────────      ───────────────── │
│ • Research 0 │  Q2 Strategy.md  Apr 20     Q2 Campaign        │
│              │  Investor Deck   Apr 18     Product X          │
│              │  Budget 2026     Apr 15     SMB Segment        │
│              │                            [more...]           │
└──────────────┴──────────────────────────────────────────────┘
```

- Left column: topic list with doc counts. Clicking a topic filters the right column.
- "All topics" option at top shows everything (unscoped).
- Search box filters entities and chunks within the selected topic.
- Sources list shows title, upload date, provenance badge (URL / file / pasted).
- Entities list shows top entities in the selected topic.

## 7.3 Ingest tab

```
┌─────────────────────────────────────────────────────────────┐
│  Source ○ URL  ○ Upload file  ● Paste text                  │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Paste your content here...                           │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
│  Topics (required *)                                        │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Business ×    [+ Add topic or type to create new]    │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
│  Notes (optional)                                           │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Source: meeting notes 2026-04-20                     │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
│  [  Ingest  ]                                               │
└─────────────────────────────────────────────────────────────┘
```

- Topic picker is a multi-select with create-on-the-fly (type a new name → Enter).
- The `*` on "Topics" label and form validation prevent submission without at least
  one topic selected.
- After successful ingest: "✓ Ingested 14 chunks into Business. View extracted →"
  button that switches to Browse tab pre-filtered to the new document.
- Progress indicator during ingestion (extraction can take 5–30 seconds if LM Studio
  is running).

---

# 8. MUST / SHOULD / NICE Slice for Phase E.2

CW: read through this list and strike through any items you want to defer or drop.
Everything in MUST is included in E.2 by default. Items in SHOULD are included if
the implementation proves straightforward; otherwise they move to E.3.

---

**MUST (ship in E.2 — these make the feature usable at all):**

- [ ] `topics` table + `source_topics` join table SQLite migrations (Section 5.2)
- [ ] `notes` column added to `documents` (Section 5.2, Migration E2-04)
- [ ] `init_db()` invoked at server startup to apply pending `subject` column migration
- [ ] `GET /api/graphrag/topics` — returns topic list with counts
- [ ] `POST /api/graphrag/topics` — create new topic (returns 409 on duplicate)
- [ ] `POST /api/graphrag/ingest-text` — accepts `topics[]` (required); returns 400 if empty
- [ ] `POST /api/graphrag/ingest-file` — same requirement
- [ ] Source provenance (`source` field) recorded on every ingested document
- [ ] Browse tab: topic list in left column, sources list filtered by selected topic
- [ ] Ingest tab: topic multi-select with create-on-the-fly, required validation

---

**SHOULD (ship in E.2 if cheap; move to E.3 if complex):**

- [ ] `POST /api/graphrag/ingest-url` — fetch URL content server-side before ingesting
- [ ] `GET /api/graphrag/sources?topic=X` — paginated sources list
- [ ] `GET /api/graphrag/search?q=X&topic=Y` — entity + chunk search scoped to topic
- [ ] Seed starter topics (`General`, `Business`, `Personal`, `Technology`, `Research`)
      at migration time
- [ ] Extraction preview: "dry-run" button in Ingest tab that shows entities that
      *would be* extracted without committing them

---

**NICE (defer to Round 3+):**

- [ ] `DELETE /api/graphrag/topics/:name` — with cascade-reassign to "General"
- [ ] `DELETE /api/graphrag/sources/:id` — with entity cascade-delete
- [ ] `GET /api/graphrag/sources/:id` — full entity + relation detail view
- [ ] `entity_topics` join table (entity-level topic propagation for faster queries)
- [ ] Hierarchical topics (`parent_id` FK, e.g., Business > Marketing > Strategy)
- [ ] Versioning (fact supersession, `superseded_by` link on entities/relations)
- [ ] Confidence / quality scoring (float column + downvote UI)
- [ ] Export / backup endpoint (`GET /api/graphrag/backup` → SQLite file download)
- [ ] Bilingual entity alignment (alias table for 中文 ↔ EN entity normalization)
- [ ] Auto-suggest topic from `classify_subject()` output on ingest form

---

# 9. Open Questions for CW

These are facts that DISCOVERY.md and the source code alone could not answer. Each
one is a single sentence from CW that unblocks a specific decision.

**Q1 — Should the `subject` auto-classification system be preserved or removed?**

The source code in `graph_store.py` has a `classify_subject()` function and 11
hardcoded subject values. These were designed as an auto-tag, not a user-defined
taxonomy. Phase E.2 adds user-defined topics alongside them. However, the subject
column will be applied to the live DB on next `init_db()` call.

*A one-sentence answer:* "Keep `subject` as an internal auto-tag (ignore in the UI)"
or "Remove `subject` entirely and replace with user topics only."

Default assumption if no answer: keep it as an internal tag, hide it from the UI.

---

**Q2 — Will the Mac mini run the same Python environment?**

The `graph_store.py` uses a hardcoded path:
```python
DB_PATH = Path("D:/AIAssist/memory/graph_rag.db")
```
This path is Windows-only. On macOS it would be something like
`/Users/cw/AIAssist/memory/graph_rag.db`.

*A one-sentence answer:* "The Mac mini will use the path `/Users/X/AIAssist/...`"
(provide the actual home directory path).

This unblocks making `DB_PATH` configurable (via env var or `config.json`) before
migration — a 2-line change in `graph_store.py`.

---

**Q3 — Is the WhatsApp bridge's `ingest_conversation()` call still desired?**

`ingestion/ingest.py` has an `ingest_conversation()` function that ingests every
WhatsApp message exchange into the graph. Since the DB is empty, this has never
actually run. With topic partitioning, these conversations would need a topic assigned
— "Conversations" is a natural choice.

*A one-sentence answer:* "Yes, keep auto-ingesting WhatsApp conversations" or "No,
leave WhatsApp conversations out of the knowledge graph."

---

**Q4 — What is the expected volume in the first month of use?**

The schema and query strategy are fine for hundreds of documents. Knowing the rough
target (10? 100? 1,000+ documents) within the first month after Phase E.2 ships
would help calibrate whether the `source_topics` JOIN approach is enough or whether
`entity_topics` should be in Phase E.2 instead of deferred to E.3.

*A one-sentence answer:* "Expecting roughly X documents in the first month."

---

# 10. Migration Readiness Note — Mac Mini (May 2026)

## Will the SQLite file port cleanly?

**Yes, with one caveat.** SQLite is a single binary file with no server process and
no platform-specific metadata. Copying `graph_rag.db` from
`D:/AIAssist/memory/graph_rag.db` on Windows to `~/AIAssist/memory/graph_rag.db` on
macOS is safe: the WAL journal will be finalized on a clean shutdown, the file format
is byte-for-byte identical across platforms, and all schema objects transfer without
encoding issues (SQLite stores UTF-8 internally, so 中文 content transfers cleanly).

**The caveat:** The `DB_PATH` constant in `graph_store.py` is hardcoded to
`D:/AIAssist/memory/graph_rag.db`. On macOS this path does not exist. Before the
migration, change this to read from an environment variable:

```python
# graph_store.py — change this before Mac mini migration
import os
DB_PATH = Path(os.environ.get("GRAPH_RAG_DB", "D:/AIAssist/memory/graph_rag.db"))
```

Then on the Mac mini, set `GRAPH_RAG_DB=/Users/cw/AIAssist/memory/graph_rag.db` in
the PM2 ecosystem config's `env` section. This is a 2-line Python change and a
1-line ecosystem.config.js addition — zero schema impact.

## Encoding on Windows → macOS move

No encoding issues expected. All strings in the DB are UTF-8. The Windows NTFS file
system and macOS APFS both handle UTF-8 SQLite files identically. The only risky
encoding scenario would be if `source` column values contain Windows-style paths
(`D:\AIAssist\...`) — these would appear as literal strings in the DB on macOS but
would not cause any errors; they just wouldn't resolve as local paths. Since those
documents were uploaded from Windows, the paths are historical records anyway.

## WAL mode safety during move

Make sure to copy the DB file when no Python process is writing to it (i.e., when
the server is stopped or the Python subprocess is idle). The WAL file (`graph_rag.db-wal`)
and the shared-memory file (`graph_rag.db-shm`) should also be copied if they exist.
If only `graph_rag.db` is copied and the WAL is left behind, SQLite will start fresh
with a clean WAL on macOS — no data loss (WAL is a write buffer, not the primary store,
and SQLite checkpoints it before a clean shutdown). To be safe: `pm2 stop ai-dashboard`
first, then copy all three files.

---

# 11. Out-of-Scope Findings

Items noticed during Phase E.1 research that are out of scope for this phase.
Logged here so they don't slip through — CW can decide whether to address them
in E.2 or a future round.

**Finding 1 — `graph_store.py` hardcoded DB path (priority: HIGH before May migration)**
As noted in Section 10, `DB_PATH = Path("D:/AIAssist/memory/graph_rag.db")` must be
made configurable before the Mac mini move. A 2-line change; low risk.

**Finding 2 — `extractor.py` does not pass `subject` (or any topic) to `upsert_entity`**
When LM Studio extracts entities and calls `upsert_entity(name, etype, description)`,
no subject/topic is passed. The `upsert_entity` function then calls `classify_subject()`
to auto-assign one. This is fine for the subject system but means that in Phase E.2,
the extractor will also need to receive the document's topic list and propagate it —
otherwise `entity_topics` (if implemented in E.3) would have nothing to populate.
**No action needed in E.2 if we use `source_topics` only (the recommended path).**

**Finding 3 — `indexed_chunks` table is created inside `extractor.py`, not in `init_db()`**
`index_unprocessed_chunks()` creates `indexed_chunks` on the fly with `CREATE TABLE IF NOT EXISTS`.
This table is not part of the documented schema (not in `graph_store.py`'s `init_db()`).
Not a bug, but it means the schema documented in DISCOVERY.md and in this write-up
omits a fifth table that exists after the first indexing run. Low priority to fix;
worth noting for completeness.

**Finding 4 — `ingest_file()` does not accept a `subject` / topic parameter**
Only `ingest_text()` has the optional `subject` parameter. The `ingest_file()` wrapper
does not pass it through, so file ingestion can never carry an explicit topic today.
Phase E.2 must add `topics: List[str]` to both `ingest_file()` and `ingest_text()`
signatures (and to the `add_document()` call chain).

---

# Summary Table — What Phase E.2 Adds vs. What Already Exists

| Capability | Today | After E.2 |
|---|---|---|
| Knowledge topics | None (auto `subject` not in DB) | User-defined topics table + join |
| Topic required at ingest | N/A | Yes — 400 if missing |
| Source provenance | `source` column exists (empty) | Populated + `notes` field added |
| Browse by topic | No UI | Browse tab with topic sidebar |
| Search scoped to topic | Partial (subject filter in code but no working column) | Search endpoint with `?topic=` |
| Ingest UI | None | Ingest sub-tab with topic picker |
| Export / backup | None | Deferred to E.3 |
| Bilingual entity alignment | None | Deferred to Round 3+ |

---

*Document produced: 2026-04-20 by Claude Code (Phase E.1).*
*Revised schema assumptions supersede DISCOVERY.md §A.4 on subject column.*
