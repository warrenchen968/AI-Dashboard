/**
 * Principle #9 — Dashboard routes for Compute / Skills / Software.
 *
 * Drop-in Express router. Uses only Node built-ins (fs, os, path, child_process,
 * http, https) — no new npm dependencies needed.
 *
 * Wire up in server.js with a single line:
 *     app.use('/api', require('./principle9-routes')({ projectRoot: __dirname }));
 *
 * Every response shape is pinned by CONTRACTS.md — don't change a field without
 * also updating smoke_test.js in the same commit.
 */

'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { exec, execFile } = require('child_process');

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function execCmd(cmd, timeoutMs = 2000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? (err.code ?? 1) : 0,
        stdout: (stdout || '').toString(),
        stderr: (stderr || '').toString(),
      });
    });
  });
}

function httpHead(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    try {
      const lib = url.startsWith('https:') ? https : http;
      const req = lib.get(url, (res) => {
        res.resume(); // drain
        done({ ok: res.statusCode >= 200 && res.statusCode < 300, code: res.statusCode });
      });
      req.on('error', (e) => done({ ok: false, code: 0, error: e.message }));
      req.setTimeout(timeoutMs, () => { req.destroy(); done({ ok: false, code: 0, error: 'timeout' }); });
    } catch (e) {
      done({ ok: false, code: 0, error: e.message });
    }
  });
}

// ---------------------------------------------------------------------------
// Compute: CPU / RAM / GPU / Disks
// ---------------------------------------------------------------------------

// CPU percent — sample idle vs total across two 100ms windows.
async function cpuPercent() {
  function sample() {
    let idle = 0, total = 0;
    for (const c of os.cpus()) {
      for (const k of Object.keys(c.times)) total += c.times[k];
      idle += c.times.idle;
    }
    return { idle, total };
  }
  const a = sample();
  await new Promise((r) => setTimeout(r, 100));
  const b = sample();
  const idleDelta = b.idle - a.idle;
  const totalDelta = b.total - a.total;
  if (totalDelta <= 0) return 0;
  return round1(100 * (1 - idleDelta / totalDelta));
}

async function readGpu() {
  // Try nvidia-smi first (covers CW's laptop if it has an NVIDIA GPU).
  const q = 'nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits';
  const r = await execCmd(q, 2000);
  if (r.ok && r.stdout.trim()) {
    const line = r.stdout.trim().split(/\r?\n/)[0];
    const parts = line.split(',').map((s) => s.trim());
    if (parts.length >= 4) {
      return {
        available: true,
        name: parts[0],
        utilPct: Number(parts[1]) || 0,
        memUsedMB: Number(parts[2]) || 0,
        memTotalMB: Number(parts[3]) || 0,
      };
    }
  }
  return { available: false, reason: r.ok ? 'nvidia-smi returned no data' : 'nvidia-smi not found' };
}

async function readDisks() {
  // Windows: use WMIC (works on Win10/11 without extra deps).
  //   wmic logicaldisk get Caption,FreeSpace,Size /format:csv
  // macOS/Linux fallback: use df -k.
  if (process.platform === 'win32') {
    const r = await execCmd('wmic logicaldisk get Caption,FreeSpace,Size /format:csv', 3000);
    if (!r.ok || !r.stdout.trim()) return [];
    const lines = r.stdout.trim().split(/\r?\n/).filter((l) => l.includes(','));
    const header = lines.shift().split(',').map((s) => s.trim());
    const iCap = header.indexOf('Caption');
    const iFree = header.indexOf('FreeSpace');
    const iSize = header.indexOf('Size');
    const out = [];
    for (const line of lines) {
      const f = line.split(',');
      const mount = (f[iCap] || '').trim();
      const free = Number(f[iFree]);
      const size = Number(f[iSize]);
      if (!mount || !size) continue;
      const used = size - free;
      out.push({
        mount,
        usedGB: round1(used / (1024 ** 3)),
        totalGB: round1(size / (1024 ** 3)),
        pct: round1((used / size) * 100),
      });
    }
    return out;
  }
  const r = await execCmd("df -k -P | tail -n +2", 2000);
  if (!r.ok) return [];
  const out = [];
  for (const line of r.stdout.trim().split(/\r?\n/)) {
    const cols = line.split(/\s+/);
    if (cols.length < 6) continue;
    const size = Number(cols[1]) * 1024;
    const used = Number(cols[2]) * 1024;
    if (!size) continue;
    out.push({
      mount: cols[5],
      usedGB: round1(used / (1024 ** 3)),
      totalGB: round1(size / (1024 ** 3)),
      pct: round1((used / size) * 100),
    });
  }
  return out;
}

async function buildCompute() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const [cpuPct, gpu, disks] = await Promise.all([cpuPercent(), readGpu(), readDisks()]);
  return {
    at: nowIso(),
    cpu: {
      pct: cpuPct,
      cores: os.cpus().length,
      load1: round1((os.loadavg && os.loadavg()[0]) || 0),
    },
    ram: {
      pct: round1((usedMem / totalMem) * 100),
      usedMB: Math.round(usedMem / (1024 ** 2)),
      totalMB: Math.round(totalMem / (1024 ** 2)),
      freeMB: Math.round(freeMem / (1024 ** 2)),
    },
    gpu,
    disks,
    uptimeSec: Math.round(os.uptime()),
  };
}

// ---------------------------------------------------------------------------
// Skills: enumerate SKILL.md across project / user / plugin directories
// ---------------------------------------------------------------------------

function defaultSkillSources(projectRoot) {
  const home = os.homedir();
  return [
    { label: 'Project skills', path: path.join(projectRoot, '.claude', 'skills') },
    { label: 'User (global) skills', path: path.join(home, '.claude', 'skills') },
    { label: 'Plugin skills', path: path.join(home, '.claude', 'plugins') },
  ];
}

function parseFrontmatter(text) {
  // Minimal YAML frontmatter parser — only the 3 fields we care about.
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return null;
  const block = text.slice(3, end);
  const out = {};
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

function firstNonEmptyLine(text) {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t && !t.startsWith('---')) return t.replace(/^#+\s*/, '');
  }
  return '';
}

function scanSkillDir(root) {
  const skills = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return skills;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const skillDir = path.join(root, ent.name);
    const skillFile = path.join(skillDir, 'SKILL.md');
    let stat;
    try { stat = fs.statSync(skillFile); } catch (_) { continue; }
    let text = '';
    try { text = fs.readFileSync(skillFile, 'utf8'); } catch (_) { text = ''; }
    const fm = parseFrontmatter(text) || {};
    const description = fm.description || firstNonEmptyLine(text.replace(/^---[\s\S]*?\n---\n?/, '')) || '';
    skills.push({
      name: fm.name || ent.name,
      description: description.slice(0, 300),
      path: skillFile,
      bytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      hasFrontmatter: !!parseFrontmatter(text),
    });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

function buildSkillsDetail(sources) {
  const out = { at: nowIso(), totalCount: 0, sources: [] };
  for (const src of sources) {
    let exists = false;
    try { exists = fs.statSync(src.path).isDirectory(); } catch (_) { exists = false; }
    const skills = exists ? scanSkillDir(src.path) : [];
    out.sources.push({ label: src.label, path: src.path, exists, skills });
    out.totalCount += skills.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Software: dependency-ordered inventory with health checks
// ---------------------------------------------------------------------------

const DEFAULT_MANIFEST = {
  items: [
    { order: 1,  layer: 'Runtime',           name: 'Node.js',          purpose: 'JS runtime for dashboard + bridges', check: { kind: 'cmd', cmd: 'node --version' },   prerequisites: [] },
    { order: 2,  layer: 'Runtime',           name: 'Python',           purpose: 'Mempalace + Graph RAG',              check: { kind: 'cmd', cmd: 'python --version' }, prerequisites: [] },
    { order: 3,  layer: 'Runtime',           name: 'Git',              purpose: 'Version control',                    check: { kind: 'cmd', cmd: 'git --version' },    prerequisites: [] },
    { order: 4,  layer: 'Runtime',           name: 'GitHub CLI',       purpose: 'Repo automation',                    check: { kind: 'cmd', cmd: 'gh --version' },     prerequisites: ['Git'] },
    { order: 5,  layer: 'Runtime',           name: 'Bun',              purpose: 'Required by gstack skill',           check: { kind: 'cmd', cmd: 'bun --version' },    prerequisites: [] },
    { order: 10, layer: 'LLM runtime',       name: 'LM Studio',        purpose: 'Local LLM serving (primary)',        check: { kind: 'http', url: 'http://127.0.0.1:1234/v1/models' }, prerequisites: [] },
    { order: 11, layer: 'LLM runtime',       name: 'Ollama',           purpose: 'Alternate local LLM serving',        check: { kind: 'http', url: 'http://127.0.0.1:11434/api/tags' }, prerequisites: [] },
    { order: 20, layer: 'Memory & knowledge', name: 'Mempalace',       purpose: 'Long-term memory store',             check: { kind: 'http', url: 'http://127.0.0.1:8765/health' },    prerequisites: ['Python'] },
    { order: 21, layer: 'Memory & knowledge', name: 'Graph RAG',       purpose: 'Knowledge graph retrieval',          check: { kind: 'http', url: 'http://127.0.0.1:8766/health' },    prerequisites: ['Python'] },
    { order: 30, layer: 'Messaging',          name: 'WhatsApp Bridge', purpose: 'Invoke assistant via WhatsApp',      check: { kind: 'pm2', process: 'whatsapp-bridge' }, prerequisites: ['Node.js', 'LM Studio'] },
    { order: 40, layer: 'Orchestration',      name: 'AI Dashboard',    purpose: 'This dashboard (self)',              check: { kind: 'self' },                         prerequisites: ['Node.js'] },
  ],
};

function loadManifest(projectRoot) {
  const file = path.join(projectRoot, 'software-manifest.json');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.items)) return parsed;
  } catch (_) {
    // fall through
  }
  return DEFAULT_MANIFEST;
}

function firstLine(s) {
  return (s || '').split(/\r?\n/)[0].trim();
}

async function runCheck(item, pm2Reader) {
  const check = item.check || { kind: 'unknown' };
  try {
    switch (check.kind) {
      case 'cmd': {
        const r = await execCmd(check.cmd, 3000);
        return r.ok
          ? { status: 'ok', version: firstLine(r.stdout) || firstLine(r.stderr) || '', detail: '' }
          : { status: 'missing', version: '', detail: firstLine(r.stderr) || `exit ${r.code}` };
      }
      case 'http': {
        const r = await httpHead(check.url, 2000);
        if (r.ok) return { status: 'ok', version: '', detail: `HTTP ${r.code}` };
        if (r.code >= 400) return { status: 'degraded', version: '', detail: `HTTP ${r.code}` };
        return { status: 'missing', version: '', detail: r.error || `HTTP ${r.code || 'unreachable'}` };
      }
      case 'pm2': {
        if (!pm2Reader) return { status: 'unknown', version: '', detail: 'pm2 reader not provided' };
        const procs = await pm2Reader();
        const match = procs.find((p) => p && p.name === check.process);
        if (!match) return { status: 'missing', version: '', detail: `pm2 process "${check.process}" not found` };
        if (match.status === 'online') return { status: 'ok', version: '', detail: `pm2: ${match.status}` };
        return { status: 'degraded', version: '', detail: `pm2: ${match.status}` };
      }
      case 'self':
        return { status: 'ok', version: process.versions.node, detail: 'pid ' + process.pid };
      default:
        return { status: 'unknown', version: '', detail: `unknown check.kind ${check.kind}` };
    }
  } catch (e) {
    return { status: 'unknown', version: '', detail: e.message };
  }
}

async function buildSoftware(projectRoot, pm2Reader) {
  const manifest = loadManifest(projectRoot);
  const items = [...manifest.items].sort((a, b) => (a.order || 0) - (b.order || 0));
  const results = await Promise.all(items.map((it) => runCheck(it, pm2Reader)));
  return {
    at: nowIso(),
    items: items.map((it, i) => ({
      order: it.order,
      layer: it.layer || '',
      name: it.name,
      purpose: it.purpose || '',
      prerequisites: Array.isArray(it.prerequisites) ? it.prerequisites : [],
      check: it.check || { kind: 'unknown' },
      status: results[i].status,
      version: results[i].version,
      detail: results[i].detail,
    })),
  };
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {string} opts.projectRoot  - dir that contains server.js (also where software-manifest.json lives)
 * @param {Array}  [opts.skillSources] - override skill source directories
 * @param {Function} [opts.pm2Reader]  - async () => [{name, status}]; defaults to trying pm2 package then pm2 CLI
 * @returns {import('express').Router}
 */
function principle9Router(opts) {
  // Lazy-load express.Router so this file still parses if express isn't installed
  // (e.g. during static lint or tests using a mock).
  const express = require('express');
  const router = express.Router();
  const projectRoot = (opts && opts.projectRoot) || process.cwd();
  const skillSources = (opts && opts.skillSources) || defaultSkillSources(projectRoot);
  const pm2Reader = (opts && opts.pm2Reader) || defaultPm2Reader();

  router.get('/compute', async (_req, res) => {
    try { res.json(await buildCompute()); }
    catch (e) { res.status(500).json({ error: 'compute_failed', detail: e.message, at: nowIso() }); }
  });

  router.get('/skills/detail', async (_req, res) => {
    try { res.json(buildSkillsDetail(skillSources)); }
    catch (e) { res.status(500).json({ error: 'skills_failed', detail: e.message, at: nowIso() }); }
  });

  router.get('/software', async (_req, res) => {
    try { res.json(await buildSoftware(projectRoot, pm2Reader)); }
    catch (e) { res.status(500).json({ error: 'software_failed', detail: e.message, at: nowIso() }); }
  });

  return router;
}

function defaultPm2Reader() {
  // Try the pm2 package first; fall back to `pm2 jlist`; if neither works, return [].
  let pm2Mod = null;
  try { pm2Mod = require('pm2'); } catch (_) { pm2Mod = null; }
  return async function readPm2() {
    if (pm2Mod) {
      return new Promise((resolve) => {
        pm2Mod.connect((err) => {
          if (err) { resolve([]); return; }
          pm2Mod.list((err2, list) => {
            pm2Mod.disconnect();
            if (err2 || !Array.isArray(list)) { resolve([]); return; }
            resolve(list.map((p) => ({ name: p.name, status: p.pm2_env && p.pm2_env.status })));
          });
        });
      });
    }
    const r = await execCmd('pm2 jlist', 3000);
    if (!r.ok) return [];
    try {
      const list = JSON.parse(r.stdout);
      return list.map((p) => ({ name: p.name, status: p.pm2_env && p.pm2_env.status }));
    } catch (_) {
      return [];
    }
  };
}

module.exports = principle9Router;
// Export internals for testing — these are unsupported API; do not rely on
// them from the main app.
module.exports._internals = {
  buildCompute,
  buildSkillsDetail,
  buildSoftware,
  parseFrontmatter,
  scanSkillDir,
  DEFAULT_MANIFEST,
  loadManifest,
  runCheck,
};
