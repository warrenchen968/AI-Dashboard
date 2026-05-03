/**
 * smoke_test — Principle #9 additions
 * ====================================
 * This file is designed to be APPENDED to your existing smoke_test.js,
 * inside the same async `main()` function, right before the final
 * `console.log("N passed, 0 failed")` block. See APPLY.md step 4 for the
 * exact paste target.
 *
 * If it's easier to keep as a standalone file, it also exports a function
 * you can import: `const runP9 = require('./smoke_test_principle9.patch');`
 * and call `await runP9({ host, port, assertShape, record });`.
 *
 * The three new contract checks mirror the structure used for the original
 * 9 endpoints: use assertShape() to assert presence + type of every field
 * documented in CONTRACTS.md.
 */

'use strict';

async function runP9({ host = '127.0.0.1', port, assertShape, record, httpGet, httpPostJson }) {
  // --- /api/compute ---------------------------------------------------------
  await record('GET /api/compute returns cpu/ram/gpu/disks/uptimeSec', async () => {
    const r = await httpGet(host, port, '/api/compute');
    if (r.status !== 200) throw new Error('status ' + r.status);
    const b = r.body;
    assertShape(b, {
      at: 'string',
      cpu: { pct: 'number', cores: 'number', load1: 'number' },
      ram: { pct: 'number', usedMB: 'number', totalMB: 'number', freeMB: 'number' },
      gpu: { available: 'boolean' }, // other fields depend on availability
      disks: 'array',
      uptimeSec: 'number',
    });
    // sanity: percentages must be in [0, 100]
    if (b.cpu.pct < 0 || b.cpu.pct > 100) throw new Error('cpu.pct out of range: ' + b.cpu.pct);
    if (b.ram.pct < 0 || b.ram.pct > 100) throw new Error('ram.pct out of range: ' + b.ram.pct);
    if (b.gpu.available) {
      assertShape(b.gpu, { name: 'string', utilPct: 'number', memUsedMB: 'number', memTotalMB: 'number' });
    } else {
      assertShape(b.gpu, { reason: 'string' });
    }
    for (const d of b.disks) {
      assertShape(d, { mount: 'string', usedGB: 'number', totalGB: 'number', pct: 'number' });
    }
  });

  // --- /api/skills/detail ---------------------------------------------------
  await record('GET /api/skills/detail returns sources[]+skills[]', async () => {
    const r = await httpGet(host, port, '/api/skills/detail');
    if (r.status !== 200) throw new Error('status ' + r.status);
    const b = r.body;
    assertShape(b, { at: 'string', totalCount: 'number', sources: 'array' });
    for (const src of b.sources) {
      assertShape(src, { label: 'string', path: 'string', exists: 'boolean', skills: 'array' });
      for (const s of src.skills) {
        assertShape(s, {
          name: 'string',
          description: 'string',
          path: 'string',
          bytes: 'number',
          modifiedAt: 'string',
          hasFrontmatter: 'boolean',
        });
      }
    }
    // totalCount must equal sum of source skill counts
    const sum = b.sources.reduce((a, s) => a + (s.skills ? s.skills.length : 0), 0);
    if (sum !== b.totalCount) throw new Error('totalCount ' + b.totalCount + ' != sum ' + sum);
  });

  // --- /api/software --------------------------------------------------------
  await record('GET /api/software returns ordered items[] with health', async () => {
    const r = await httpGet(host, port, '/api/software');
    if (r.status !== 200) throw new Error('status ' + r.status);
    const b = r.body;
    assertShape(b, { at: 'string', items: 'array' });
    let prevOrder = -Infinity;
    const validStatus = new Set(['ok', 'missing', 'degraded', 'unknown']);
    const validKinds = new Set(['cmd', 'http', 'pm2', 'self', 'fs', 'pip', 'compound']);
    for (const it of b.items) {
      assertShape(it, {
        order: 'number',
        layer: 'string',
        name: 'string',
        purpose: 'string',
        prerequisites: 'array',
        check: 'object',
        status: 'string',
        version: 'string',
        detail: 'string',
      });
      if (!validStatus.has(it.status)) throw new Error('invalid status "' + it.status + '" for ' + it.name);
      if (it.check && it.check.kind && !validKinds.has(it.check.kind))
        throw new Error('invalid check.kind "' + it.check.kind + '" for ' + it.name);
      if (it.order < prevOrder) throw new Error('items not sorted by order: ' + it.name);
      prevOrder = it.order;
      for (const p of it.prerequisites) {
        if (typeof p !== 'string') throw new Error('prerequisite for ' + it.name + ' must be string');
      }
    }
    // The AI Dashboard self-entry must report "ok" (we're talking to it).
    const self = b.items.find((i) => (i.check && i.check.kind === 'self'));
    if (self && self.status !== 'ok') throw new Error('self-check not ok: ' + self.detail);
  });

  // --- Phase B additions ---------------------------------------------------

  await record('Ollama is gone from /api/software', async () => {
    const r = await httpGet(host, port, '/api/software');
    if (r.body.items.some((it) => /ollama/i.test(it.name))) throw new Error('Ollama still listed');
  });

  await record('LM Studio uses compound check', async () => {
    const r = await httpGet(host, port, '/api/software');
    const lm = r.body.items.find((it) => /lm[-_ ]?studio/i.test(it.name));
    if (!lm) throw new Error('LM Studio missing');
    if (lm.check.kind !== 'compound') throw new Error('expected compound check, got ' + lm.check.kind);
    if (!['ok', 'degraded', 'missing'].includes(lm.status)) throw new Error('unexpected status ' + lm.status);
  });

  await record('Mempalace and Graph RAG no longer use HTTP checks', async () => {
    const r = await httpGet(host, port, '/api/software');
    for (const name of ['Mempalace', 'Graph RAG']) {
      const it = r.body.items.find((x) => x.name === name);
      if (!it) throw new Error(name + ' missing');
      if (it.check.kind === 'http') throw new Error(name + ' still uses http check; expected pip or fs');
    }
  });
  // --- Phase C additions ---------------------------------------------------

  await record('whatsapp-bridge appears in /api/services', async () => {
    const r = await httpGet(host, port, '/api/services');
    if (!r.body.find(s => s.id === 'whatsapp-bridge'))
      throw new Error('whatsapp-bridge missing from /api/services');
  });

  await record('wechat-bridge appears in /api/services and is not online', async () => {
    const r = await httpGet(host, port, '/api/services');
    const w = r.body.find(s => s.id === 'wechat-bridge');
    if (!w) throw new Error('wechat-bridge missing from /api/services');
    if (w.status === 'online') throw new Error('wechat-bridge should default to stopped (issue #6)');
  });

  await record('start/stop endpoints reject unknown service', async () => {
    const r = await httpPostJson(host, port, '/api/services/notarealthing/start', {});
    if (r.status !== 400) throw new Error('expected 400, got ' + r.status);
  });

  // --- Phase D additions ---------------------------------------------------

  await record('GET /api/services includes LM Studio as external', async () => {
    const r = await httpGet(host, port, '/api/services');
    const lm = r.body.find(s => /lm[-_ ]?studio/i.test(s.name));
    if (!lm) throw new Error('LM Studio missing from /api/services');
    if (lm.kind !== 'external') throw new Error('kind: ' + lm.kind);
    if (lm.controllable !== false) throw new Error('controllable should be false');
    if (!lm.extras || typeof lm.extras !== 'object') throw new Error('extras missing');
    if (!Array.isArray(lm.extras.models)) throw new Error('extras.models not array');
    if (!('loadedModelId' in lm.extras)) throw new Error('extras.loadedModelId missing');
  });

  await record('PM2 services have kind="pm2" and controllable=true', async () => {
    const r = await httpGet(host, port, '/api/services');
    // Lookup by id; name field has display casing ('AI Dashboard', 'WhatsApp Bridge', etc.)
    for (const id of ['ai-dashboard', 'whatsapp-bridge', 'wechat-bridge']) {
      const s = r.body.find(x => x.id === id);
      if (!s) throw new Error(id + ' missing from /api/services');
      if (s.kind !== 'pm2') throw new Error(id + ' kind: ' + s.kind);
      if (s.controllable !== true) throw new Error(id + ' should be controllable');
    }
  });

  await record('LM Studio models list consistent with loadedModelId', async () => {
    const r = await httpGet(host, port, '/api/services');
    const lm = r.body.find(s => /lm[-_ ]?studio/i.test(s.name));
    const loaded = lm.extras.models.filter(m => m.loaded);
    if (loaded.length > 1) throw new Error('>1 model marked loaded');
    if (loaded.length === 1 && loaded[0].id !== lm.extras.loadedModelId)
      throw new Error('loaded flag disagrees with loadedModelId');
    if (loaded.length === 0 && lm.extras.loadedModelId !== null)
      throw new Error('loadedModelId set but no model flagged loaded');
  });

  // --- Phase E.2 additions -------------------------------------------------

  await record('topics CRUD round-trips', async () => {
    const name = 'smoke-topic-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    // Create
    const r1 = await httpPostJson(host, port, '/api/graphrag/topics', { name });
    if (r1.status !== 201) throw new Error('create: expected 201, got ' + r1.status + ' — ' + JSON.stringify(r1.body));
    if (!r1.body || r1.body.name !== name) throw new Error('create: name mismatch — got ' + JSON.stringify(r1.body));
    if (!r1.body.createdAt) throw new Error('create: createdAt missing');
    // List — created topic must appear
    const r2 = await httpGet(host, port, '/api/graphrag/topics');
    if (r2.status !== 200) throw new Error('list: expected 200, got ' + r2.status);
    if (!Array.isArray(r2.body && r2.body.topics)) throw new Error('list: topics not array');
    if (!r2.body.topics.find(t => t.name === name)) throw new Error('list: created topic absent');
    // Duplicate → 409
    const r3 = await httpPostJson(host, port, '/api/graphrag/topics', { name });
    if (r3.status !== 409) throw new Error('duplicate: expected 409, got ' + r3.status);
    if (!r3.body || r3.body.error !== 'topic exists') throw new Error('duplicate: error field wrong — ' + JSON.stringify(r3.body));
  });

  await record('ingest-text rejects missing topics', async () => {
    const r1 = await httpPostJson(host, port, '/api/graphrag/ingest-text', { text: 'hello' });
    if (r1.status !== 400) throw new Error('no topics: expected 400, got ' + r1.status);
    const r2 = await httpPostJson(host, port, '/api/graphrag/ingest-text', { text: 'hello', topics: [] });
    if (r2.status !== 400) throw new Error('empty topics: expected 400, got ' + r2.status);
  });

  await record('ingest-text succeeds with topics', async () => {
    const sentinel = 'smoke ingest sentinel ' + Date.now();
    const r = await httpPostJson(host, port, '/api/graphrag/ingest-text', {
      text: sentinel,
      topics: ['smoke-test'],
    });
    if (r.status !== 200) throw new Error('expected 200, got ' + r.status + ' — ' + JSON.stringify(r.body));
    if (!r.body || !r.body.sourceId) throw new Error('sourceId missing or falsy');
    if (typeof r.body.chunks !== 'number' || r.body.chunks < 1) throw new Error('chunks must be a number >= 1, got ' + r.body.chunks);
    if (!Array.isArray(r.body.topics) || !r.body.topics.includes('smoke-test')) throw new Error('topics missing "smoke-test" — got ' + JSON.stringify(r.body.topics));
  });

  // --- Phase R3-P02a additions ---------------------------------------------

  await record('GET /api/skills/registry returns version + skills[] + lastSync', async () => {
    const r = await httpGet(host, port, '/api/skills/registry');
    if (r.status !== 200 && r.status !== 503) throw new Error('unexpected status ' + r.status);
    const b = r.body;
    if (!b || typeof b !== 'object') throw new Error('expected object response');
    if (!('skills' in b))  throw new Error('missing key: skills');
    if (!('version' in b)) throw new Error('missing key: version');
    // lastSync is null when index.json not yet created (503 path), present otherwise
    if (!('lastSync' in b)) throw new Error('missing key: lastSync');
    if (!Array.isArray(b.skills)) throw new Error('skills must be an array');
  });

  await record('skills-watcher appears in /api/services with kind="pm2"', async () => {
    const r = await httpGet(host, port, '/api/services');
    if (r.status !== 200) throw new Error('status ' + r.status);
    const sw = r.body.find(s => s.id === 'skills-watcher');
    if (!sw) throw new Error('skills-watcher missing from /api/services');
    if (sw.kind !== 'pm2') throw new Error('skills-watcher kind: ' + sw.kind + ' (expected pm2)');
  });

  await record('dashboard.html contains Skills Registry tab element', async () => {
    const fs = require('fs');
    const path = require('path');
    const html = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
    if (!html.includes('id="p-skills-registry"'))
      throw new Error('p-skills-registry page div not found in dashboard.html');
    if (!html.includes("nav('skills-registry')"))
      throw new Error('skills-registry nav handler not found in dashboard.html');
  });
}

module.exports = runP9;
