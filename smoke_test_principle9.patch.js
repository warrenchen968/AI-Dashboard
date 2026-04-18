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

async function runP9({ host = '127.0.0.1', port, assertShape, record, httpGet }) {
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
}

module.exports = runP9;
