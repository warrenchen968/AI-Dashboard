/**
 * AI Dashboard — Regression Smoke Test
 *
 * Purpose:
 *   Boots server.js with child_process stubbed, hits every public endpoint,
 *   and asserts the response shape matches what dashboard.html expects.
 *
 * When to run:
 *   1. Before starting work on a new feature  → establishes baseline.
 *   2. After editing server.js OR dashboard.html → catches contract breaks.
 *   3. Before `pm2 restart ai-dashboard` in production.
 *
 * Usage:
 *   cd D:\AIAssist\dashboard\AI-Dashboard
 *   node smoke_test.js
 *
 * Exit code 0 = all green. Non-zero = investigate before shipping.
 *
 * NOTE: This stubs out pm2/python/nvidia-smi calls. Real integration health
 *       must be verified against a live system (see REGRESSION_TEST_GUIDE.md).
 */
'use strict';

const http = require('http');
const cp   = require('child_process');

// ── Stub child_process.exec so pm2/python/lms/nvidia-smi do not break the test ─
cp.exec = (cmd, opts, cb) => {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  process.nextTick(() => cb(new Error('stubbed'), '', ''));
};

require('./server.js');

// Expected response-shape contracts (dashboard.html depends on these keys).
const CONTRACTS = {
  '/api/status':            { must: ['system', 'processes'] },
  '/api/quick':             {
    must: ['whatsapp', 'wechat', 'lmstudio', 'mempalace',
           'system', 'services', 'servicesOnline', 'servicesTotal',
           'processes', 'graphrag'],
    systemKeys:   ['cpuPct', 'ramPct', 'ramUsedGB', 'ramTotalGB', 'uptimeSec'],
    graphragKeys: ['online', 'entities', 'relations', 'documents', 'chunks'],
  },
  '/api/services':          { isArray: true },
  '/api/graphrag/stats':    { must: ['online', 'entities', 'relations', 'documents', 'chunks'] },
  '/api/graphrag/subjects': { must: ['subjects'] },
  '/api/skills':            { must: ['skills'] },
  '/api/memory/milestones': { must: ['milestones'] },
  '/api/memory/stats':      { must: ['totalTurns', 'totalDays'] },
  '/api/gpu':               { must: ['ok', 'gpus'] },
};

function get(path) {
  return new Promise(resolve => {
    const req = http.request(
      { host: '127.0.0.1', port: process.env.PORT ? Number(process.env.PORT) : 7788, path, method: 'GET', timeout: 4000 },
      res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(d); } catch {}
          resolve({ status: res.statusCode, body: parsed, raw: d });
        });
      }
    );
    req.on('error',   e => resolve({ error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.end();
  });
}

function checkShape(path, body) {
  const c = CONTRACTS[path];
  if (!c) return [];
  const fails = [];
  if (c.isArray && !Array.isArray(body)) fails.push('expected array');
  if (c.must) {
    for (const k of c.must) {
      if (!body || !(k in body)) fails.push(`missing key: ${k}`);
    }
  }
  if (c.systemKeys && body && body.system) {
    for (const k of c.systemKeys) {
      if (!(k in body.system)) fails.push(`system.${k} missing`);
    }
  }
  if (c.graphragKeys && body && body.graphrag) {
    for (const k of c.graphragKeys) {
      if (!(k in body.graphrag)) fails.push(`graphrag.${k} missing`);
    }
  }
  return fails;
}

(async () => {
  // Let server.poll() run once (it will fail gracefully under stub).
  await new Promise(r => setTimeout(r, 800));

  let pass = 0, fail = 0;
  const lines = [];

  const host = '127.0.0.1';
  const port = process.env.PORT ? Number(process.env.PORT) : 7788;

  function httpGet(h, p, pathname) { return get(pathname); }

  function assertShape(obj, shape, _path) {
    _path = _path || '';
    for (const [k, expected] of Object.entries(shape)) {
      const v = obj == null ? undefined : obj[k];
      const pp = _path ? _path + '.' + k : k;
      if (typeof expected === 'string') {
        const actual = Array.isArray(v) ? 'array' : typeof v;
        if (actual !== expected) throw new Error(`${pp}: expected ${expected}, got ${actual}`);
      } else if (typeof expected === 'object') {
        if (typeof v !== 'object' || v === null) throw new Error(`${pp}: expected object`);
        assertShape(v, expected, pp);
      }
    }
  }

  async function record(name, fn) {
    try {
      await fn();
      lines.push(`  ✓ ${name}`); pass++;
    } catch (e) {
      lines.push(`  ✗ ${name}  ${e.message}`); fail++;
    }
  }

  for (const path of Object.keys(CONTRACTS)) {
    const r = await get(path);
    if (r.error)       { lines.push(`  ✗ ${path}  ERROR: ${r.error}`);                fail++; continue; }
    if (r.status !== 200) { lines.push(`  ✗ ${path}  HTTP ${r.status}`);              fail++; continue; }
    const shapeErrors = checkShape(path, r.body);
    if (shapeErrors.length) { lines.push(`  ✗ ${path}  SHAPE: ${shapeErrors.join('; ')}`); fail++; continue; }
    lines.push(`  ✓ ${path}`); pass++;
  }

  // Principle #9 contract checks
  const runP9 = require('./smoke_test_principle9.patch');
  await runP9({ host, port, assertShape, record, httpGet });

  console.log('\n=== AI Dashboard Regression Smoke Test ===');
  lines.forEach(l => console.log(l));
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
