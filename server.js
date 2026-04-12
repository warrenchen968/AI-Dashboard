/**
 * AI Assistant — Control Center Backend
 * - Background data polling every 5 minutes (no popup windows)
 * - PM2 process control (start/stop/restart) via API
 * - LM Studio server control via lms CLI
 * - Real-time log streaming via SSE
 * - Localhost-only security
 */

const http    = require('http');
const os      = require('os');
const fs      = require('fs');
const path    = require('path');
const { spawn, exec } = require('child_process');
const { promisify }   = require('util');
const execAsync = promisify(exec);

const PORT           = 7788;
const POLL_INTERVAL  = 5 * 60 * 1000; // 5 minutes
const LOG_LINES      = 120;            // lines to return per log request

// ─── Cached state (updated by background poller) ──────────────────────────────
let cachedStatus = null;
let lastPollTime = null;
let polling      = false;

// ─── SSE clients for live log streaming ───────────────────────────────────────
const sseClients = new Map(); // clientId -> res

// ─── Security ─────────────────────────────────────────────────────────────────
function isAllowed(req) {
  const addr = req.socket.remoteAddress;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

// ─── Silent exec (windowsHide prevents CMD popups) ───────────────────────────
function silent(cmd, opts = {}) {
  return execAsync(cmd, {
    windowsHide: true,   // ← KEY: no popup window on Windows
    timeout: 10000,
    ...opts,
  });
}

// ─── CPU ──────────────────────────────────────────────────────────────────────
function getCpuUsage() {
  return new Promise((resolve) => {
    const c1 = os.cpus();
    setTimeout(() => {
      const c2 = os.cpus();
      let idle = 0, total = 0;
      c2.forEach((cpu, i) => {
        for (const t in cpu.times) total += cpu.times[t] - c1[i].times[t];
        idle += cpu.times.idle - c1[i].times.idle;
      });
      resolve(Math.max(0, Math.min(100, Math.round(100 - (100 * idle / total)))));
    }, 600);
  });
}

// ─── RAM ──────────────────────────────────────────────────────────────────────
function getMemInfo() {
  const total = os.totalmem();
  const used  = total - os.freemem();
  return {
    total:   (total / 1073741824).toFixed(1),
    used:    (used  / 1073741824).toFixed(1),
    percent: Math.round((used / total) * 100),
  };
}

// ─── PM2 processes ────────────────────────────────────────────────────────────
async function getPM2() {
  try {
    const { stdout } = await silent('pm2 jlist');
    return JSON.parse(stdout).map(p => ({
      id:       p.pm_id,
      name:     p.name,
      status:   p.pm2_env?.status  || 'unknown',
      cpu:      p.monit?.cpu       ?? 0,
      memory:   ((p.monit?.memory  ?? 0) / 1048576).toFixed(1),
      restarts: p.pm2_env?.restart_time ?? 0,
      uptime:   p.pm2_env?.pm_uptime
                  ? Math.round((Date.now() - p.pm2_env.pm_uptime) / 60000) + 'm'
                  : '—',
      pid:      p.pid || null,
    }));
  } catch { return []; }
}

// ─── LM Studio ────────────────────────────────────────────────────────────────
async function getLMStudio() {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: 'localhost', port: 1234, path: '/v1/models', method: 'GET', timeout: 3000 },
      (res) => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          try {
            const models = (JSON.parse(data).data || []).map(m => m.id);
            resolve({ online: true, models });
          } catch { resolve({ online: true, models: [] }); }
        });
      }
    );
    req.on('error',   () => resolve({ online: false, models: [] }));
    req.on('timeout', () => { req.destroy(); resolve({ online: false, models: [] }); });
    req.end();
  });
}

// ─── WhatsApp Bridge status (check via PM2 + port probe) ─────────────────────
async function getWhatsAppBridge(pm2List) {
  const proc = pm2List.find(p => p.name === 'whatsapp-bridge');
  if (!proc) return { online: false, status: 'not found in PM2', pm2: false };
  return {
    online:   proc.status === 'online',
    status:   proc.status,
    cpu:      proc.cpu,
    memory:   proc.memory,
    restarts: proc.restarts,
    uptime:   proc.uptime,
    pm2:      true,
  };
}

// ─── Software deps ────────────────────────────────────────────────────────────
async function getSoftwareDeps() {
  const checks = [
    { name: 'Node.js',       cmd: 'node --version',      category: 'runtime',   required: true  },
    { name: 'Python',        cmd: 'python --version',    category: 'runtime',   required: true  },
    { name: 'Git',           cmd: 'git --version',       category: 'runtime',   required: true  },
    { name: 'PM2',           cmd: 'pm2 --version',       category: 'process',   required: true  },
    { name: 'LM Studio CLI', cmd: 'lms --version',       category: 'ai',        required: true  },
    { name: 'Claude Code',   cmd: 'claude --version',    category: 'ai',        required: false },
    { name: 'Docker',        cmd: 'docker --version',    category: 'container', required: false },
    { name: 'MemPalace',     cmd: 'mempalace --version', category: 'skill',     required: true  },
  ];
  return Promise.all(checks.map(async d => {
    try {
      const { stdout } = await silent(d.cmd, { timeout: 4000 });
      return { ...d, installed: true, version: stdout.trim().split('\n')[0] };
    } catch {
      return { ...d, installed: false, version: null };
    }
  }));
}

// ─── Skills ───────────────────────────────────────────────────────────────────
function getSkills() {
  const base = 'D:\\AIAssist';
  const known = [
    { name: 'whatsapp-bridge',  category: 'bridge',  path: `${base}\\whatsapp-bridge` },
    { name: 'mempalace',        category: 'memory',  path: `${base}\\skills\\builtin\\mempalace` },
    { name: 'agentic-harness',  category: 'agent',   path: `${base}\\skills\\builtin\\agentic-harness-patterns-skill` },
    { name: 'ai-dashboard',     category: 'infra',   path: `${base}\\dashboard` },
  ];
  return known.map(s => ({
    ...s,
    installed: fs.existsSync(s.path),
    status: fs.existsSync(s.path) ? 'installed' : 'missing',
  }));
}

// ─── Full poll ────────────────────────────────────────────────────────────────
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const [cpu, pm2, lmstudio, software] = await Promise.all([
      getCpuUsage(),
      getPM2(),
      getLMStudio(),
      getSoftwareDeps(),
    ]);
    const whatsapp = await getWhatsAppBridge(pm2);
    cachedStatus = {
      timestamp: new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' }),
      system: {
        cpu,
        memory:   getMemInfo(),
        uptime:   (() => { const s = os.uptime(); return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`; })(),
        platform: os.platform(),
        hostname: os.hostname(),
        cpuModel: (os.cpus()[0]?.model || '').replace(/\s+/g, ' '),
        cpuCores: os.cpus().length,
      },
      processes: pm2,
      lmstudio,
      whatsapp,
      skills:   getSkills(),
      software,
    };
    lastPollTime = Date.now();
    console.log(`[${new Date().toLocaleTimeString()}] ✓ Poll complete`);
  } catch (e) {
    console.error('Poll error:', e.message);
  } finally {
    polling = false;
  }
}

// ─── Background poller ────────────────────────────────────────────────────────
poll(); // immediate on start
setInterval(poll, POLL_INTERVAL);

// ─── Log reader ───────────────────────────────────────────────────────────────
async function getProcessLogs(name) {
  // Try PM2 log files first (fast, no popup)
  const logPaths = [
    path.join(os.homedir(), '.pm2', 'logs', `${name}-out.log`),
    path.join(os.homedir(), '.pm2', 'logs', `${name}-error.log`),
    `D:\\AIAssist\\${name}\\logs`,
  ];

  let lines = [];

  for (const p of logPaths) {
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      const content = fs.readFileSync(p, 'utf8');
      const fileLines = content.split('\n').filter(Boolean).slice(-LOG_LINES);
      lines.push(...fileLines.map(l => ({ source: path.basename(p), line: l })));
    }
  }

  if (lines.length > 0) {
    return lines.slice(-LOG_LINES);
  }

  // Fallback: pm2 logs via CLI (windowsHide)
  try {
    const { stdout } = await silent(`pm2 logs ${name} --lines ${LOG_LINES} --nostream`, { timeout: 8000 });
    return stdout.split('\n').filter(Boolean).map(l => ({ source: 'pm2', line: l }));
  } catch (e) {
    return [{ source: 'error', line: 'Could not read logs: ' + e.message }];
  }
}

// ─── Process control ──────────────────────────────────────────────────────────
async function controlProcess(action, target) {
  const allowed = ['start', 'stop', 'restart', 'reload'];
  if (!allowed.includes(action)) throw new Error('Invalid action');

  // Whitelist of controllable services
  const whitelist = ['whatsapp-bridge', 'ai-dashboard', 'all'];
  if (!whitelist.includes(target)) throw new Error('Target not in whitelist');

  const { stdout, stderr } = await silent(`pm2 ${action} ${target}`);
  await poll(); // refresh cache immediately
  return { ok: true, output: stdout + stderr };
}

// ─── LM Studio control ────────────────────────────────────────────────────────
async function controlLMStudio(action) {
  if (!['start', 'stop', 'status'].includes(action)) throw new Error('Invalid action');
  const { stdout, stderr } = await silent(`lms server ${action}`);
  await poll();
  return { ok: true, output: stdout + stderr };
}

// ─── HTTP Router ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (!isAllowed(req)) { res.writeHead(403); res.end('Forbidden'); return; }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url  = req.url.split('?')[0];
  const query = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);

  // ── Serve HTML ──
  if (url === '/' || url === '/dashboard') {
    const p = path.join(__dirname, 'dashboard.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.existsSync(p) ? fs.readFileSync(p) : 'dashboard.html missing');
    return;
  }

  // ── GET /api/status — serve cached data ──
  if (url === '/api/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ...cachedStatus,
      meta: { lastPoll: lastPollTime, nextPoll: lastPollTime + POLL_INTERVAL, polling }
    }));
    return;
  }

  // ── GET /api/poll — force immediate poll ──
  if (url === '/api/poll' && req.method === 'GET') {
    await poll();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, timestamp: cachedStatus?.timestamp }));
    return;
  }

  // ── GET /api/logs?name=whatsapp-bridge ──
  if (url === '/api/logs' && req.method === 'GET') {
    const name = query.name;
    if (!name) { res.writeHead(400); res.end('Missing ?name='); return; }
    const logs = await getProcessLogs(name);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ name, logs }));
    return;
  }

  // ── POST /api/control — PM2 process control ──
  // Body: { action: 'start|stop|restart', target: 'whatsapp-bridge' }
  if (url === '/api/control' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { action, target } = JSON.parse(body);
        const result = await controlProcess(action, target);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── POST /api/lmstudio — LM Studio control ──
  // Body: { action: 'start|stop|status' }
  if (url === '/api/lmstudio' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { action } = JSON.parse(body);
        const result = await controlLMStudio(action);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── GET /api/quick — lightweight poll for WhatsApp /status ──
  if (url === '/api/quick') {
    const mem = getMemInfo();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      cpu:     cachedStatus?.system?.cpu ?? '?',
      ram:     mem.percent,
      uptime:  cachedStatus?.system?.uptime ?? '?',
      whatsapp: cachedStatus?.whatsapp?.online ?? false,
      lmstudio: cachedStatus?.lmstudio?.online ?? false,
    }));
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   AI Assistant — Control Center          ║');
  console.log(`║   http://localhost:${PORT}/dashboard        ║`);
  console.log('║   Background polling every 5 minutes     ║');
  console.log('╚══════════════════════════════════════════╝');
});

process.on('SIGINT', () => { console.log('\nShutting down...'); process.exit(0); });
