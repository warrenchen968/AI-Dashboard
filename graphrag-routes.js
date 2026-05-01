/**
 * Graph RAG API routes — Phase E.2
 *
 * GET  /api/graphrag/topics              → {topics:[{name,count,createdAt}]}
 * POST /api/graphrag/topics              body:{name} → 201{name,createdAt} | 409{error,name}
 * POST /api/graphrag/ingest-text         body:{text,topics[],notes?} → 200{sourceId,topics,ingestedAt,chunks}
 * POST /api/graphrag/ingest-file         body:{filePath,topics[],notes?} → 200{sourceId,...,fileName}
 *
 * Option α: all operations via Python subprocess (no SQLite npm dep in this project).
 *
 * Usage in server.js:
 *   const handleGraphrag = require('./graphrag-routes');
 *   // inside request handler, before the 404:
 *   if (url.startsWith('/api/graphrag/')) { await handleGraphrag(url, req, res, json, readBody); return; }
 */

'use strict';

const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const crypto = require('crypto');

const GRAPH_RAG_ROOT = 'D:/AIAssist/home/graph-rag';
// No surrounding quotes — the path is injected directly into the command string below.
const PYTHON_CMD = 'C:\\Users\\warre\\AppData\\Local\\Programs\\Python\\Python311\\python.exe';

/**
 * Run a Python script given as an array of source lines.
 * Writes the lines to a temp .py file and executes that file — no shell
 * escaping of newlines, quotes, or backslashes required.
 */
async function pyRun(scriptLines, timeoutMs = 15000) {
  const tmpFile = path.join(
    os.tmpdir(),
    `graphrag-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.py`
  );
  fs.writeFileSync(tmpFile, scriptLines.join('\n'), 'utf8');
  try {
    return await execAsync(
      `"${PYTHON_CMD}" "${tmpFile}"`,
      { windowsHide: true, timeout: timeoutMs }
    );
  } finally {
    fs.unlink(tmpFile, () => {});
  }
}

/**
 * Fire-and-forget background Python execution via temp file.
 * Temp file is deleted in the exec callback — safe even if the script hangs.
 */
function pyRunBg(scriptLines, timeoutMs = 120000) {
  const tmpFile = path.join(
    os.tmpdir(),
    `graphrag-bg-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.py`
  );
  fs.writeFileSync(tmpFile, scriptLines.join('\n'), 'utf8');
  exec(
    `"${PYTHON_CMD}" "${tmpFile}"`,
    { windowsHide: true, timeout: timeoutMs },
    () => fs.unlink(tmpFile, () => {})
  );
}

function bgIndex() {
  pyRunBg([
    `import sys`,
    `sys.path.insert(0, '${GRAPH_RAG_ROOT}')`,
    `from indexing.extractor import index_unprocessed_chunks`,
    `index_unprocessed_chunks(20)`,
  ]);
}

/**
 * Main handler — call from server.js for any url starting with /api/graphrag/
 * @param {string}   url      — path without query string
 * @param {object}   req      — Node IncomingMessage
 * @param {object}   res      — Node ServerResponse
 * @param {function} json     — (data, code?) helper already defined in server.js
 * @param {function} readBody — body parser already defined in server.js
 */
async function handleGraphrag(url, req, res, json, readBody) {

  // ── GET /api/graphrag/topics ───────────────────────────────────────────────
  if (url === '/api/graphrag/topics' && req.method === 'GET') {
    const lines = [
      `import sys, json`,
      `sys.path.insert(0, '${GRAPH_RAG_ROOT}')`,
      `from topics import list_topics`,
      `ts = list_topics()`,
      `out = [{'name': t['name'], 'count': t['count'], 'createdAt': t['created_at']} for t in ts]`,
      `print(json.dumps({'topics': out}))`,
    ];
    try {
      const { stdout } = await pyRun(lines);
      json(JSON.parse(stdout.trim()));
    } catch (e) { json({ error: e.message }, 500); }
    return;
  }

  // ── POST /api/graphrag/topics ──────────────────────────────────────────────
  if (url === '/api/graphrag/topics' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch { return json({ error: 'invalid JSON' }, 400); }
    const name = (body.name || '').trim();
    if (!name) return json({ error: 'name required' }, 400);

    const safeName = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const lines = [
      `import sys, json`,
      `sys.path.insert(0, '${GRAPH_RAG_ROOT}')`,
      `from topics import create_topic, TopicExistsError`,
      `try:`,
      `    t = create_topic('${safeName}')`,
      `    print(json.dumps({'ok': True, 'name': t['name'], 'createdAt': t['created_at']}))`,
      `except TopicExistsError:`,
      `    print(json.dumps({'ok': False, 'exists': True}))`,
    ];
    try {
      const { stdout } = await pyRun(lines);
      const result = JSON.parse(stdout.trim());
      if (result.exists) return json({ error: 'topic exists', name }, 409);
      json({ name: result.name, createdAt: result.createdAt }, 201);
    } catch (e) { json({ error: e.message }, 500); }
    return;
  }

  // ── POST /api/graphrag/ingest-text ─────────────────────────────────────────
  if (url === '/api/graphrag/ingest-text' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch { return json({ error: 'invalid JSON' }, 400); }

    const { text, topics, notes } = body;
    if (!text || typeof text !== 'string') return json({ error: 'text required' }, 400);
    if (!Array.isArray(topics) || topics.filter(Boolean).length === 0)
      return json({ error: 'topics required — pass at least one topic name' }, 400);

    const cleanTopics = topics.map(t => String(t).trim()).filter(Boolean);
    // JSON.stringify produces valid Python string literals directly — no extra
    // shell escaping needed now that pyRun writes to a temp file (not -c "...").
    const safeTopics  = JSON.stringify(cleanTopics);
    const safeText    = JSON.stringify(text);
    const safeNotes   = JSON.stringify((notes || '').toString());
    const title       = 'dashboard-paste-' + Date.now();

    const lines = [
      `import sys, json`,
      `sys.path.insert(0, '${GRAPH_RAG_ROOT}')`,
      `from ingestion.ingest import ingest_text`,
      `r = ingest_text(${JSON.stringify(title)}, ${safeText}, source='dashboard', topics=${safeTopics}, ingested_by='user', notes=${safeNotes})`,
      `print(json.dumps({'sourceId': r['doc_id'], 'topics': r['topics'], 'isNew': r['is_new'], 'chunks': r['chunks']}))`,
    ];
    try {
      const { stdout } = await pyRun(lines, 30000);
      const result = JSON.parse(stdout.trim());
      json({ sourceId: result.sourceId, topics: cleanTopics, ingestedAt: new Date().toISOString(), chunks: result.chunks });
      bgIndex();
    } catch (e) { json({ error: e.message }, 500); }
    return;
  }

  // ── POST /api/graphrag/ingest-file ─────────────────────────────────────────
  // Accepts {filePath, topics[], notes?} — server reads the file from the given path.
  if (url === '/api/graphrag/ingest-file' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch { return json({ error: 'invalid JSON' }, 400); }

    const { filePath, topics, notes } = body;
    if (!filePath) return json({ error: 'filePath required' }, 400);
    if (!Array.isArray(topics) || topics.filter(Boolean).length === 0)
      return json({ error: 'topics required — pass at least one topic name' }, 400);

    const cleanTopics  = topics.map(t => String(t).trim()).filter(Boolean);
    // JSON.stringify produces valid Python string literals directly — no extra
    // shell escaping needed now that pyRun writes to a temp file (not -c "...").
    const safeTopics   = JSON.stringify(cleanTopics);
    const safeFilePath = JSON.stringify(filePath.replace(/\\/g, '/'));
    const safeNotes    = JSON.stringify((notes || '').toString());

    const lines = [
      `import sys, json`,
      `sys.path.insert(0, '${GRAPH_RAG_ROOT}')`,
      `from ingestion.ingest import ingest_file`,
      `r = ingest_file(${safeFilePath}, topics=${safeTopics}, ingested_by='user', notes=${safeNotes})`,
      `print(json.dumps(r if 'error' in r else {'sourceId': r['doc_id'], 'topics': r['topics'], 'isNew': r['is_new'], 'chunks': r['chunks']}))`,
    ];
    try {
      const { stdout } = await pyRun(lines, 30000);
      const result = JSON.parse(stdout.trim());
      if (result.error) return json({ error: result.error }, 400);
      const fileName = filePath.split(/[\\/]/).pop();
      json({ sourceId: result.sourceId, topics: cleanTopics, ingestedAt: new Date().toISOString(), fileName, chunks: result.chunks });
      bgIndex();
    } catch (e) { json({ error: e.message }, 500); }
    return;
  }

  // Unknown /api/graphrag/* route
  json({ error: 'Not found' }, 404);
}

module.exports = handleGraphrag;
