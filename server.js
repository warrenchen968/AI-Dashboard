/**
 * AI Assistant — Control Center v5
 * Port: 7788  →  http://localhost:7788/dashboard
 *
 * New in v5:
 *   - Graph RAG API: stats, subjects, search, file upload (base64 JSON), URL ingest
 *   - WeChat Bridge service monitoring
 *   - Architecture diagram data endpoint
 *   - Tech stack / skills API
 *   - Service start/stop for all managed services
 */

const http    = require('http');
const https   = require('https');
const os      = require('os');
const fs      = require('fs');
const path    = require('path');
const { exec, spawn } = require('child_process');
const { promisify }   = require('util');
const execAsync = promisify(exec);

// Zero-dep URL fetcher that follows up to 5 redirects (replaces axios).
function fetchUrl(targetUrl, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('Too many redirects'));
    let u;
    try { u = new URL(targetUrl); } catch { return reject(new Error('Invalid URL')); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      { method:'GET', hostname:u.hostname, port:u.port||undefined, path:u.pathname+u.search,
        headers:{ 'User-Agent':'Mozilla/5.0 (AI-Dashboard)', 'Accept':'text/html,*/*' },
        timeout:15000 },
      res => {
        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, targetUrl).toString();
          return resolve(fetchUrl(next, depth+1));
        }
        if (res.statusCode < 200 || res.statusCode >= 300)
          return reject(new Error(`HTTP ${res.statusCode}`));
        let data = '';
        res.setEncoding('utf8');
        res.on('data', c => data += c);
        res.on('end', () => resolve(data));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.end();
  });
}

const PORT          = process.env.PORT ? Number(process.env.PORT) : 7788;
const POLL_INTERVAL = 5 * 60 * 1000;
const LOG_LINES     = 150;

const BASE = 'D:\\AIAssist';
const PATHS = {
  dashboard: `${BASE}\\dashboard\\AI-Dashboard`,
  palace:    `${BASE}\\memory`,
  convDir:   `${BASE}\\memory\\conversations`,
  graphDB:   `${BASE}\\memory\\graph_rag.db`,
  waConfig:  `${BASE}\\whatsapp-bridge\\config.json`,
  waLogs:    `${BASE}\\whatsapp-bridge\\logs`,
  wcConfig:  `${BASE}\\wechat-bridge\\config.json`,
  pm2Logs:   path.join(os.homedir(), '.pm2', 'logs'),
  graphRag:  `${BASE}\\home\\graph-rag`,
  python:    'C:\\Users\\warre\\AppData\\Local\\Programs\\Python\\Python311\\python.exe',
};

const MP_CMD = `"${PATHS.python}" -m mempalace`;
const PY_CMD = `"${PATHS.python}"`;

// ─── Security (localhost only) ────────────────────────────────────────────────
const isAllowed = req => {
  const a = req.socket.remoteAddress;
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
};

const silent = (cmd, opts = {}) =>
  execAsync(cmd, { windowsHide: true, timeout: 15000, ...opts });

// ─── Cache ────────────────────────────────────────────────────────────────────
let cachedStatus = null;
let lastPollTime = null;
let polling      = false;

// ─── CPU / Memory / Disk ──────────────────────────────────────────────────────
function getCpuUsage() {
  return new Promise(resolve => {
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

const getMemInfo = () => {
  const total = os.totalmem(), used = total - os.freemem();
  return {
    total:   (total / 1073741824).toFixed(1),
    used:    (used  / 1073741824).toFixed(1),
    free:    ((total - used) / 1073741824).toFixed(1),
    percent: Math.round((used / total) * 100),
  };
};

async function getGPUInfo() {
  try {
    const { stdout } = await silent(
      'nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits',
      { timeout: 6000 }
    );
    const gpus = stdout.trim().split('\n').filter(Boolean).map((line, i) => {
      const [name, util, memUsed, memTotal, temp] = line.split(',').map(s => s.trim());
      return { index: i, vendor: 'NVIDIA', name,
        utilPercent: parseInt(util) || 0,
        memUsedMB: parseInt(memUsed) || 0, memTotalMB: parseInt(memTotal) || 0,
        memPercent: memTotal ? Math.round((parseInt(memUsed)/parseInt(memTotal))*100) : 0,
        tempC: parseInt(temp) || 0 };
    });
    return { ok: true, vendor: 'NVIDIA', gpus };
  } catch {}
  try {
    const { stdout } = await silent('wmic path win32_VideoController get Name,AdapterRAM /format:csv', { timeout: 5000 });
    const gpus = stdout.trim().split('\n').filter(l => l.includes(',') && !l.includes('Node')).map((line, i) => {
      const parts = line.split(',');
      return { index: i, vendor: 'Generic', name: parts[2]?.trim() || 'GPU',
        utilPercent: 0, memTotalMB: Math.round((parseInt(parts[1])||0)/1048576),
        memUsedMB: 0, memPercent: 0, tempC: 0 };
    });
    return { ok: true, vendor: 'Generic', gpus };
  } catch {}
  return { ok: false, vendor: 'Unknown', gpus: [] };
}

async function getDiskInfo() {
  const disks = [];
  try {
    const { stdout } = await silent('wmic logicaldisk get DeviceID,Size,FreeSpace,VolumeName /format:csv', { timeout: 5000 });
    for (const line of stdout.trim().split('\n').filter(l => l.includes(',') && !l.includes('DeviceID'))) {
      const parts = line.split(',');
      if (parts.length < 5) continue;
      const id = parts[1]?.trim(), free = parseInt(parts[2]) || 0, size = parseInt(parts[3]) || 0;
      if (!id || !size) continue;
      disks.push({ id, vol: parts[4]?.trim() || id,
        totalGB: (size/1073741824).toFixed(1), freeGB: (free/1073741824).toFixed(1),
        usedGB: ((size-free)/1073741824).toFixed(1), percent: Math.round(((size-free)/size)*100) });
    }
  } catch {}
  return disks;
}

async function getAIProcesses() {
  const procs = [], targets = ['lms', 'node', 'python', 'ollama'];
  try {
    const { stdout } = await silent('wmic process get Name,ProcessId,WorkingSetSize,CommandLine /format:csv', { timeout: 8000 });
    for (const line of stdout.trim().split('\n').filter(l => l.includes(',') && !l.includes('Node,'))) {
      const parts = line.split(',');
      if (parts.length < 4) continue;
      const name = parts[2]?.trim()?.toLowerCase() || '';
      if (!targets.some(t => name.includes(t))) continue;
      procs.push({ name: parts[2]?.trim(), pid: parseInt(parts[3])||0,
        memMB: Math.round((parseInt(parts[4])||0)/1048576), cmd: parts.slice(5).join(',').trim().substring(0,80) });
    }
  } catch {}
  return procs.sort((a,b) => b.memMB-a.memMB).slice(0,10);
}

// ─── PM2 ──────────────────────────────────────────────────────────────────────
async function getPM2() {
  try {
    const { stdout } = await silent('pm2 jlist');
    return JSON.parse(stdout).map(p => {
      const memBytes = p.monit?.memory ?? 0;
      const upMs     = p.pm2_env?.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : 0;
      return {
        id:        p.pm_id,
        name:      p.name,
        status:    p.pm2_env?.status || 'unknown',
        cpu:       p.monit?.cpu ?? 0,
        // Provide both raw and formatted values for front-end flexibility.
        memory:    (memBytes / 1048576).toFixed(1),   // MB (string) — legacy
        memoryMB:  Math.round(memBytes / 1048576),     // MB (number)
        memoryBytes: memBytes,                         // raw bytes
        restarts:  p.pm2_env?.restart_time ?? 0,
        uptime:    upMs ? Math.round(upMs / 60000) + 'm' : '—',  // legacy string
        uptimeMs:  upMs,                               // raw ms
        uptimeSec: Math.round(upMs / 1000),
        pid:       p.pid || null,
      };
    });
  } catch { return []; }
}

// ─── LM Studio ────────────────────────────────────────────────────────────────
async function getLMStudio() {
  return new Promise(resolve => {
    const req = http.request(
      { hostname:'localhost', port:1234, path:'/v1/models', method:'GET', timeout:3000 },
      res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{
        try { resolve({ online:true, models:(JSON.parse(d).data||[]).map(m=>m.id) }); }
        catch { resolve({ online:true, models:[] }); }
      }); }
    );
    req.on('error',   () => resolve({ online:false, models:[] }));
    req.on('timeout', () => { req.destroy(); resolve({ online:false, models:[] }); });
    req.end();
  });
}

// ─── WhatsApp / WeChat status ─────────────────────────────────────────────────
async function getWhatsApp(pm2) {
  const p = pm2.find(x => x.name === 'whatsapp-bridge');
  if (!p) return { online:false, status:'not in PM2', pm2:false };
  return { online:p.status==='online', status:p.status, cpu:p.cpu, memory:p.memory, restarts:p.restarts, uptime:p.uptime, pm2:true };
}

async function getWeChat(pm2) {
  const p = pm2.find(x => x.name === 'wechat-bridge');
  if (!p) return { online:false, status:'not in PM2', pm2:false };
  return { online:p.status==='online', status:p.status, cpu:p.cpu, memory:p.memory, restarts:p.restarts, uptime:p.uptime, pm2:true };
}

// ─── MemPalace ────────────────────────────────────────────────────────────────
async function getMemPalaceStatus() {
  const r = { online:false, installed:false, version:null, initialized:false, convFiles:0, lastMine:null, totalMemories:0, detail:'' };
  try {
    await silent(`${MP_CMD} --help`, { timeout:5000 });
    r.installed = true; r.online = true;
  } catch(e) { r.detail='mempalace not found: '+e.message; return r; }
  r.initialized = fs.existsSync(PATHS.palace);
  try {
    const { stdout } = await silent(`${MP_CMD} status`, { timeout:8000 });
    r.initialized = !stdout.includes('No palace found');
    r.detail = stdout.trim().split('\n').filter(l=>l.trim()).slice(0,5).join(' | ');
    const m = stdout.match(/(\d+)\s*(memor|closet|drawer|item)/i);
    if (m) r.totalMemories = parseInt(m[1]);
  } catch {}
  try {
    if (fs.existsSync(PATHS.convDir)) {
      const files = fs.readdirSync(PATHS.convDir).filter(f=>f.endsWith('.txt'));
      r.convFiles = files.length;
      const mt = files.map(f=>fs.statSync(path.join(PATHS.convDir,f)).mtimeMs);
      if (mt.length) r.lastMine = new Date(Math.max(...mt)).toLocaleString('en-AU',{timeZone:'Australia/Sydney'});
    }
  } catch {}
  return r;
}

// ─── Graph RAG status ─────────────────────────────────────────────────────────
async function getGraphRAGStatus() {
  const dbExists = fs.existsSync(PATHS.graphDB);
  if (!dbExists) return { online: false, entities:0, relations:0, documents:0, chunks:0, subjects:[] };
  try {
    const script = `
import sys, json
sys.path.insert(0,'${PATHS.graphRag.replace(/\\/g,'/')}')
from graph_store import get_graph_stats, get_subjects_summary
print(json.dumps({'stats': get_graph_stats(), 'subjects': get_subjects_summary()}))
`;
    const { stdout } = await silent(`${PY_CMD} -c "${script.replace(/\n/g,' ').replace(/"/g,'\\"')}"`, { timeout:8000 });
    const data = JSON.parse(stdout.trim());
    return { online:true, ...data.stats, subjects: data.subjects || [] };
  } catch(e) {
    return { online: dbExists, entities:0, relations:0, documents:0, chunks:0, subjects:[], error: e.message };
  }
}

// ─── Graph RAG search ─────────────────────────────────────────────────────────
async function searchGraphRAG(query, subject) {
  const subjectFilter = subject ? `, subject='${subject}'` : '';
  const script = `
import sys, json
sys.path.insert(0,'${PATHS.graphRag.replace(/\\/g,'/')}')
from retrieval.retriever import retrieve
r=retrieve(${JSON.stringify(query)})
print(json.dumps({'entities':r['entities'][:10],'chunks':r['chunks'][:5],'summary':r['summary']}))
`;
  try {
    const { stdout } = await silent(`${PY_CMD} -c "${script.replace(/\n/g,' ').replace(/"/g,'\\"')}"`, { timeout:15000 });
    return JSON.parse(stdout.trim());
  } catch(e) { return { entities:[], chunks:[], summary:'', error:e.message }; }
}

// ─── Graph RAG ingest (from dashboard) ───────────────────────────────────────
async function ingestTextToGraph(title, content, source, subject) {
  const tempFile = path.join(PATHS.palace, `upload_${Date.now()}.json`);
  const payload  = JSON.stringify({ title, content, source: source||'dashboard-upload', subject: subject||null });
  fs.writeFileSync(tempFile, payload, 'utf8');
  const script = `
import sys,json
sys.path.insert(0,'${PATHS.graphRag.replace(/\\/g,'/')}')
from ingestion.ingest import ingest_text
with open(r'${tempFile.replace(/\\/g,'\\\\')}') as f: d=json.load(f)
r=ingest_text(d['title'],d['content'],d.get('source',''),d.get('subject'))
print(json.dumps(r))
`;
  try {
    const { stdout } = await silent(`${PY_CMD} -c "${script.replace(/\n/g,' ').replace(/"/g,'\\"')}"`, { timeout:30000 });
    // Background index
    const idxScript = `import sys;sys.path.insert(0,'${PATHS.graphRag.replace(/\\/g,'/')}');from indexing.extractor import index_unprocessed_chunks;index_unprocessed_chunks(20)`;
    exec(`${PY_CMD} -c "${idxScript}"`, { windowsHide:true, timeout:120000 });
    return JSON.parse(stdout.trim());
  } finally {
    try { fs.unlinkSync(tempFile); } catch {}
  }
}

// ─── Graph RAG subjects detail ────────────────────────────────────────────────
async function getSubjectDetail(subject) {
  const script = `
import sys,json
sys.path.insert(0,'${PATHS.graphRag.replace(/\\/g,'/')}')
from graph_store import get_entities_by_subject,get_documents_by_subject
e=get_entities_by_subject(${JSON.stringify(subject)},50)
d=get_documents_by_subject(${JSON.stringify(subject)},20)
print(json.dumps({'entities':e,'documents':d}))
`;
  try {
    const { stdout } = await silent(`${PY_CMD} -c "${script.replace(/\n/g,' ').replace(/"/g,'\\"')}"`, { timeout:10000 });
    return JSON.parse(stdout.trim());
  } catch(e) { return { entities:[], documents:[], error:e.message }; }
}

// ─── Software stack ───────────────────────────────────────────────────────────
async function getSoftwareDeps() {
  const checks = [
    { name:'Node.js',       cmd:'node --version',       category:'runtime',   required:true  },
    { name:'Python 3.11',   cmd:'python --version',     category:'runtime',   required:true  },
    { name:'Git',           cmd:'git --version',        category:'runtime',   required:true  },
    { name:'PM2',           cmd:'pm2 --version',        category:'process',   required:true  },
    { name:'LM Studio CLI', cmd:'lms --version',        category:'ai',        required:true  },
    { name:'Claude Code',   cmd:'claude --version',     category:'ai',        required:false },
    { name:'MemPalace',     cmd:`${MP_CMD} --help`,     category:'memory',    required:true  },
    { name:'Playwright',    cmd:'python -m playwright --version', category:'automation', required:false },
    { name:'Wechaty',       cmd:'node -e "require(\'wechaty\')"', category:'bridge', required:false },
    { name:'nvidia-smi',    cmd:'nvidia-smi --version', category:'gpu',       required:false },
  ];
  return Promise.all(checks.map(async d => {
    try { const {stdout}=await silent(d.cmd,{timeout:4000}); return {...d,installed:true,version:stdout.trim().split('\n')[0]}; }
    catch { return {...d,installed:false,version:null}; }
  }));
}

// ─── Skills ───────────────────────────────────────────────────────────────────
function getSkills() {
  return [
    { name:'WhatsApp Bridge',  category:'bridge',     path:`${BASE}\\whatsapp-bridge`,                  version:'v3' },
    { name:'WeChat Bridge',    category:'bridge',     path:`${BASE}\\wechat-bridge`,                    version:'v1' },
    { name:'LM Studio',        category:'ai',         path:'localhost:1234',                            version:'api' },
    { name:'MemPalace',        category:'memory',     path:`${BASE}\\memory`,                           version:'cli' },
    { name:'Graph RAG',        category:'knowledge',  path:`${BASE}\\home\\graph-rag`,                  version:'v1' },
    { name:'Harness Framework',category:'agent',      path:`${BASE}\\home\\harness`,                    version:'v1' },
    { name:'CEO Agent',        category:'agent',      path:`${BASE}\\home\\orchestration\\agents`,      version:'v1' },
    { name:'Automation Agent', category:'agent',      path:`${BASE}\\home\\orchestration\\agents`,      version:'v1' },
    { name:'AI Dashboard',     category:'infra',      path:`${BASE}\\dashboard\\AI-Dashboard`,          version:'v5' },
  ].map(s => ({
    ...s,
    installed: s.path.startsWith('localhost') ? true : fs.existsSync(s.path),
    status:    s.path.startsWith('localhost') ? 'api'  : (fs.existsSync(s.path) ? 'installed' : 'missing'),
  }));
}

// ─── Services definition ──────────────────────────────────────────────────────
function getServicesDefinition() {
  return [
    { id:'whatsapp-bridge', name:'WhatsApp Bridge', type:'pm2',      icon:'📱', description:'WhatsApp ↔ X bridge',     pm2Name:'whatsapp-bridge', script:`${BASE}\\whatsapp-bridge\\bridge.js`,           cwd:`${BASE}\\whatsapp-bridge` },
    { id:'wechat-bridge',   name:'WeChat Bridge',   type:'pm2',      icon:'💬', description:'WeChat ↔ X bridge',       pm2Name:'wechat-bridge',   script:`${BASE}\\wechat-bridge\\bridge.js`,             cwd:`${BASE}\\wechat-bridge` },
    { id:'lmstudio',        name:'LM Studio',       type:'external', icon:'🧠', description:'Local LLM server',        checkUrl:'http://localhost:1234/v1/models' },
    { id:'mempalace',       name:'MemPalace',        type:'cli',      icon:'🏛', description:'Long-term memory CLI',    cmd:MP_CMD },
    { id:'graph-rag',       name:'Graph RAG',        type:'db',       icon:'🕸', description:'Knowledge graph',         dbPath:PATHS.graphDB },
    { id:'ai-dashboard',    name:'AI Dashboard',     type:'self',     icon:'📊', description:'This dashboard',          port:PORT },
  ];
}

// ─── Memory helpers ───────────────────────────────────────────────────────────
async function searchMemPalace(query, wing='') {
  const q = query.replace(/"/g,"'").substring(0,200);
  const wf = wing ? `--wing "${wing}"` : '';
  try {
    const {stdout} = await silent(`${MP_CMD} search "${q}" ${wf} --results 10`,{timeout:10000});
    return { ok:true, results:stdout.trim() };
  } catch(e) { return { ok:false, error:e.message }; }
}
async function mineMemPalace(target='') {
  const dir = target || PATHS.convDir;
  try {
    const {stdout,stderr} = await silent(`${MP_CMD} mine "${dir}" --mode convos --wing whatsapp`,{timeout:120000});
    return { ok:true, output:(stdout+stderr).trim() };
  } catch(e) { return { ok:false, error:e.message }; }
}

function getMemoryMilestones() {
  const milestones=[], patterns=[
    { re:/successfully|完成|成功|done|working|✅/i, type:'success', label:'Achievement' },
    { re:/install|installed|setup|configured/i,     type:'install', label:'Setup' },
    { re:/error.*fixed|fixed.*error|resolved|修复/i,type:'fix',     label:'Bug Fixed' },
    { re:/new feature|feature|implemented/i,         type:'feature', label:'New Feature' },
  ];
  try {
    if (!fs.existsSync(PATHS.convDir)) return milestones;
    const files=fs.readdirSync(PATHS.convDir).filter(f=>f.endsWith('.txt')).sort().slice(-20);
    for (const file of files) {
      const content=fs.readFileSync(path.join(PATHS.convDir,file),'utf8');
      const dateMatch=file.match(/\d{4}-\d{2}-\d{2}/);
      const date=dateMatch?dateMatch[0]:'Unknown';
      for (const line of content.split('\n')) {
        for (const p of patterns) {
          if (p.re.test(line)&&line.length>20&&line.length<300) {
            const text=line.replace(/^(User:|Assistant:)\s*/i,'').trim();
            if (text.length>15) { milestones.push({date,type:p.type,label:p.label,text:text.substring(0,150)}); break; }
          }
        }
      }
    }
  } catch {}
  return milestones.slice(-30);
}

function getConvStats() {
  const s={totalTurns:0,totalDays:0,avgTurnsPerDay:0,firstDate:null,lastDate:null,byDay:[]};
  try {
    if (!fs.existsSync(PATHS.convDir)) return s;
    const files=fs.readdirSync(PATHS.convDir).filter(f=>f.endsWith('.txt')).sort();
    s.totalDays=files.length;
    for (const f of files) {
      const content=fs.readFileSync(path.join(PATHS.convDir,f),'utf8');
      const turns=(content.match(/^User:/mg)||[]).length;
      s.totalTurns+=turns;
      const dm=f.match(/\d{4}-\d{2}-\d{2}/);
      if (dm) { if (!s.firstDate) s.firstDate=dm[0]; s.lastDate=dm[0]; s.byDay.push({date:dm[0],turns}); }
    }
    if (s.totalDays) s.avgTurnsPerDay=Math.round(s.totalTurns/s.totalDays);
  } catch {}
  return s;
}

// ─── Process control ──────────────────────────────────────────────────────────
const PM2_SCRIPTS = {
  'whatsapp-bridge': { script:`${BASE}\\whatsapp-bridge\\bridge.js`, cwd:`${BASE}\\whatsapp-bridge` },
  'wechat-bridge':   { script:`${BASE}\\wechat-bridge\\bridge.js`,   cwd:`${BASE}\\wechat-bridge`   },
  'ai-dashboard':    { script:`${BASE}\\dashboard\\AI-Dashboard\\server.js`, cwd:`${BASE}\\dashboard\\AI-Dashboard` },
};
async function controlProcess(action, target) {
  const allowed = ['whatsapp-bridge','wechat-bridge','ai-dashboard','memory-miner','all'];
  if (!['start','stop','restart','reload'].includes(action)) throw new Error('Invalid action');
  if (!allowed.includes(target)) throw new Error('Not whitelisted: '+target);
  let cmd;
  if (action === 'start' && PM2_SCRIPTS[target]) {
    const pm2List = cachedStatus?.processes || [];
    const existing = pm2List.find(p => p.name === target);
    if (existing) {
      cmd = `pm2 restart "${target}"`;
    } else {
      const { script, cwd } = PM2_SCRIPTS[target];
      cmd = `pm2 start "${script}" --name "${target}"${cwd ? ` --cwd "${cwd}"` : ''}`;
    }
  } else {
    cmd = `pm2 ${action} "${target}"`;
  }
  const {stdout,stderr} = await silent(cmd);
  await poll();
  return { ok:true, output:stdout+stderr };
}
async function controlLMStudio(action) {
  if (!['start','stop','status'].includes(action)) throw new Error('Invalid action');
  const {stdout,stderr} = await silent(`lms server ${action}`);
  await poll();
  return { ok:true, output:stdout+stderr };
}

async function releaseResource(action) {
  const results = [];
  if (action==='clear-temp') {
    try { await silent('cmd /c del /q /f "%TEMP%\\*.tmp" 2>nul',{timeout:10000}); results.push('✓ Cleared temp files'); } catch { results.push('⚠ Partial'); }
  } else if (action==='stop-lmstudio') {
    try { await silent('lms server stop',{timeout:8000}); results.push('✓ LM Studio stopped'); } catch(e) { results.push('✗ '+e.message); }
  } else if (action==='trim-node') {
    try { await silent('pm2 restart whatsapp-bridge'); results.push('✓ Restarted whatsapp-bridge'); } catch(e) { results.push('✗ '+e.message); }
  } else results.push('Unknown: '+action);
  return { ok:true, results };
}

async function killProcess(pid) {
  if (!pid||isNaN(pid)) throw new Error('Invalid PID');
  if (parseInt(pid)<100) throw new Error('Refusing to kill system PID');
  await silent(`taskkill /PID ${pid} /F`,{timeout:5000});
  return { ok:true, message:`Process ${pid} terminated` };
}

// ─── Full Poll ────────────────────────────────────────────────────────────────
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const [cpu, pm2, lmstudio, software, mempalace, gpu, disk, aiProcs, graphrag] = await Promise.all([
      getCpuUsage(), getPM2(), getLMStudio(), getSoftwareDeps(),
      getMemPalaceStatus(), getGPUInfo(), getDiskInfo(), getAIProcesses(), getGraphRAGStatus(),
    ]);
    const [whatsapp, wechat] = await Promise.all([getWhatsApp(pm2), getWeChat(pm2)]);
    const s = os.uptime();
    cachedStatus = {
      timestamp: new Date().toLocaleString('en-AU',{timeZone:'Australia/Sydney'}),
      system: {
        cpu, memory:getMemInfo(),
        uptime:`${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`,
        platform:os.platform(), hostname:os.hostname(),
        cpuModel:(os.cpus()[0]?.model||'').replace(/\s+/g,' '),
        cpuCores:os.cpus().length,
      },
      processes:pm2, lmstudio, whatsapp, wechat, mempalace, graphrag,
      gpu, disk, aiProcs, skills:getSkills(), software,
      services: getServicesDefinition(),
    };
    lastPollTime = Date.now();
  } catch(e) { console.error('Poll error:', e.message); }
  finally { polling = false; }
}

poll();
setInterval(poll, POLL_INTERVAL);

// ─── Log reader ───────────────────────────────────────────────────────────────
async function getProcessLogs(name, limit) {
  const lim = Math.max(10, Math.min(500, parseInt(limit) || LOG_LINES));
  let lines = [];
  const candidates = [
    path.join(PATHS.pm2Logs, `${name}-out.log`),
    path.join(PATHS.pm2Logs, `${name}-error.log`),
    path.join(PATHS.waLogs,  `${name}.log`),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p) && fs.statSync(p).isFile())
      lines.push(
        ...fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).slice(-lim)
          .map(l => ({ source: path.basename(p), line: l }))
      );
  }
  if (lines.length) return lines.slice(-lim);
  try {
    const { stdout } = await silent(`pm2 logs ${name} --lines ${lim} --nostream`, { timeout: 8000 });
    return stdout.split('\n').filter(Boolean).map(l => ({ source: 'pm2', line: l }));
  } catch (e) {
    return [{ source: 'error', line: 'Could not read logs: ' + e.message }];
  }
}

// ─── Body parser ──────────────────────────────────────────────────────────────
const readBody = req => new Promise((res,rej) => {
  let b=''; req.on('data',d=>b+=d);
  req.on('end',()=>{ try{res(JSON.parse(b||'{}'))}catch(e){rej(e)}; });
});

// ─── External service helpers (Phase D) ──────────────────────────────────────
const { buildLmStudioService } = require('./services-external');

// ─── Graph RAG routes (Phase E.2) ────────────────────────────────────────────
const handleGraphrag = require('./graphrag-routes');

// ─── Principle #9 panels (Compute / Skills / Software) ───────────────────────
const { _internals: p9 } = require('./principle9-routes');
const p9SkillSources = [
  { label: 'Project skills',       path: path.join(__dirname, '.claude', 'skills') },
  { label: 'User (global) skills', path: path.join(os.homedir(), '.claude', 'skills') },
  { label: 'Plugin skills',        path: path.join(os.homedir(), '.claude', 'plugins') },
];
const p9Pm2Reader = () => getPM2().then(list => list.map(p => ({ name: p.name, status: p.status })));

// ─── HTTP Router ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (!isAllowed(req)) { res.writeHead(403); res.end('Forbidden'); return; }
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method==='OPTIONS') { res.writeHead(204); res.end(); return; }

  const url   = req.url.split('?')[0];
  const query = Object.fromEntries(new URL(req.url,'http://localhost').searchParams);
  const json  = (data,code=200) => { res.writeHead(code,{'Content-Type':'application/json'}); res.end(JSON.stringify(data)); };

  try {
    // ── Dashboard HTML ──────────────────────────────────────────────────────
    if (url==='/' || url==='/dashboard') {
      const p = path.join(__dirname,'dashboard.html');
      res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});
      res.end(fs.existsSync(p) ? fs.readFileSync(p) : '<h1>dashboard.html missing</h1>');
      return;
    }

    // ── Core status ─────────────────────────────────────────────────────────
    if (url==='/api/status')  { json({...cachedStatus,meta:{lastPoll:lastPollTime,nextPoll:lastPollTime?lastPollTime+POLL_INTERVAL:null,polling}}); return; }
    if (url==='/api/poll')    { await poll(); json({ok:true}); return; }
    if (url==='/api/quick')   {
      const m = getMemInfo();
      const pm2 = cachedStatus?.processes || [];

      // Enrich services the same way /api/services does so the dashboard
      // can render overview & services page from the same shape.
      const svcDefs = cachedStatus?.services || getServicesDefinition();
      const services = svcDefs.map(svc => {
        let online = false, status = 'unknown';
        if (svc.type === 'pm2') {
          const p = pm2.find(x => x.name === svc.pm2Name);
          online = p?.status === 'online';
          status = p?.status || 'not in PM2';
        } else if (svc.type === 'db') {
          online = fs.existsSync(svc.dbPath || '');
          status = online ? 'online' : 'no-db';
        } else if (svc.type === 'self') {
          online = true; status = 'online';
        } else if (svc.type === 'external') {
          online = cachedStatus?.lmstudio?.online ?? false;
          status = online ? 'online' : 'offline';
        } else if (svc.type === 'cli') {
          online = cachedStatus?.mempalace?.online ?? false;
          status = online ? 'online' : 'offline';
        }
        return { ...svc, online, status };
      });
      const servicesOnline = services.filter(s => s.online).length;

      json({
        // Pills (booleans — dashboard uses truthy check)
        whatsapp:  cachedStatus?.whatsapp?.online  ?? false,
        wechat:    cachedStatus?.wechat?.online    ?? false,
        lmstudio:  cachedStatus?.lmstudio?.online  ?? false,
        mempalace: cachedStatus?.mempalace?.online ?? false,

        // System stats (in the shape the dashboard expects)
        system: {
          cpuPct:     cachedStatus?.system?.cpu ?? 0,
          ramPct:     m.percent,
          ramUsedGB:  parseFloat(m.used),
          ramTotalGB: parseFloat(m.total),
          uptimeSec:  os.uptime(),
          uptime:     cachedStatus?.system?.uptime ?? '—',
        },

        // Services & processes
        services,
        servicesOnline,
        servicesTotal: services.length,
        processes: pm2,

        // Graph RAG (full object — dashboard will read .online, .entities, etc.)
        graphrag: cachedStatus?.graphrag || {
          online: false, entities: 0, relations: 0,
          documents: 0, chunks: 0, subjects: []
        },

        // Optional GPU util
        gpu: cachedStatus?.gpu?.gpus?.[0]?.utilPercent ?? null,

        // Meta
        meta: { lastPoll: lastPollTime, polling, cacheWarm: !!cachedStatus },
      });
      return;
    }

    // ── Graph RAG ────────────────────────────────────────────────────────────
    if (url==='/api/graphrag/stats') { json(await getGraphRAGStatus()); return; }

    if (url==='/api/graphrag/subjects') {
      const status = await getGraphRAGStatus();
      json({ subjects: status.subjects || [] }); return;
    }

    if (url==='/api/graphrag/subject' && query.name) {
      json(await getSubjectDetail(query.name)); return;
    }

    if (url==='/api/graphrag/search') {
      const q = query.q || '';
      if (!q) { json({error:'Missing ?q='}, 400); return; }
      json(await searchGraphRAG(q, query.subject||'')); return;
    }

    if (url==='/api/graphrag/upload' && req.method==='POST') {
      // Accepts: { title, content, source?, subject? }
      // OR:      { title, file_base64, filename, source?, subject? }
      const body = await readBody(req);
      let content = body.content;
      if (!content && body.file_base64) {
        content = Buffer.from(body.file_base64, 'base64').toString('utf-8');
      }
      if (!content || !body.title) { json({error:'Missing title or content'},400); return; }
      json(await ingestTextToGraph(body.title, content, body.source||'', body.subject||null)); return;
    }

    if (url==='/api/graphrag/recent') {
      const script = `
import sys, json
sys.path.insert(0, 'D:/AIAssist/home/graph-rag')
from graph_store import get_recent_documents
print(json.dumps(get_recent_documents(20)))
`;
      try {
        const tmp = require('os').tmpdir() + '/dash_recent_' + Date.now() + '.py';
        require('fs').writeFileSync(tmp, script);
        const { stdout } = await silent(`${PY_CMD} "${tmp}"`, { timeout: 15000 });
        require('fs').unlinkSync(tmp);
        json({ documents: JSON.parse(stdout.trim() || '[]') });
      } catch(e) { json({ error: e.message }); }
      return;
    }

    if (url==='/api/graphrag/ingest-url' && req.method==='POST') {
      const { url: targetUrl, subject } = await readBody(req);
      if (!targetUrl) { json({error:'Missing url'},400); return; }
      try {
        const raw  = await fetchUrl(targetUrl);
        const text = raw.replace(/<[^>]+>/g,'').replace(/\s{2,}/g,' ').trim();
        const title = targetUrl.replace(/https?:\/\//,'').substring(0,80);
        json(await ingestTextToGraph(title, text, targetUrl, subject||null));
      } catch(e) { json({error:'Fetch failed: '+e.message},500); }
      return;
    }

    // ── Services ─────────────────────────────────────────────────────────────
    if (url==='/api/services') {
      // Filter out LM Studio — it gets its own synthetic entry from buildLmStudioService().
      const defs = getServicesDefinition().filter(s => s.id !== 'lmstudio');
      const pm2  = cachedStatus?.processes || [];
      const enriched = defs.map(svc => {
        let online = false, status = 'unknown';
        if (svc.type==='pm2') {
          const p=pm2.find(x=>x.name===svc.pm2Name);
          online=p?.status==='online'; status=p?.status||'not in PM2';
        } else if (svc.type==='db') {
          online=fs.existsSync(svc.dbPath||''); status=online?'online':'no-db';
        } else if (svc.type==='self') {
          online=true; status='online';
        } else if (svc.type==='cli') {
          online=cachedStatus?.mempalace?.online??false;
          status=online?'online':'offline';
        }
        // kind and controllable: Phase D additions (strictly additive).
        // 'pm2' and 'self' types are PM2-managed; dashboard can start/stop them.
        const controllable = svc.type === 'pm2' || svc.type === 'self';
        return { ...svc, online, status, kind: controllable ? 'pm2' : 'external', controllable };
      });
      const lmEntry = await buildLmStudioService();
      json([...enriched, lmEntry]); return;
    }

    if (url.startsWith('/api/services/') && req.method==='POST') {
      const parts  = url.split('/');
      const svcId  = parts[3];
      const action = parts[4]; // start|stop|restart
      if (!['start','stop','restart'].includes(action)) { json({error:'Invalid action'},400); return; }
      // Allowlist: only PM2-managed services accept start/stop/restart.
      const ALLOWED_SVC = new Set(['ai-dashboard', 'whatsapp-bridge', 'wechat-bridge', 'memory-miner']);
      if (!ALLOWED_SVC.has(svcId)) { json({error:'unknown service', name:svcId}, 400); return; }
      const svcDef  = getServicesDefinition().find(s => s.id === svcId);
      const pm2Name = svcDef?.pm2Name || svcId;
      try {
        let cmd;
        if (action === 'start' && svcDef?.script) {
          // Check if the process is already registered in PM2
          const pm2List = cachedStatus?.processes || [];
          const existing = pm2List.find(p => p.name === pm2Name);
          if (existing) {
            cmd = `pm2 restart "${pm2Name}"`;
          } else {
            cmd = `pm2 start "${svcDef.script}" --name "${pm2Name}"${svcDef.cwd ? ` --cwd "${svcDef.cwd}"` : ''}`;
          }
        } else {
          cmd = `pm2 ${action} "${pm2Name}"`;
        }
        const { stdout } = await silent(cmd);
        await poll();
        json({ ok:true, output:stdout });
      } catch(e) { json({ok:false, error:e.message}); }
      return;
    }

    // ── Memory ───────────────────────────────────────────────────────────────
    if (url==='/api/memory/milestones') { json({milestones:getMemoryMilestones()}); return; }
    if (url==='/api/memory/stats')      { json(getConvStats()); return; }
    if (url==='/api/memory/search') {
      // Accept GET (?q=...&wing=...) or POST ({query, wing}) for flexibility.
      let q = query.q || query.query || '';
      let wing = query.wing || '';
      if (req.method === 'POST') {
        try {
          const body = await readBody(req);
          q = body.query || body.q || q;
          wing = body.wing || wing;
        } catch {}
      }
      if (!q) { json({ ok:false, error:'Missing query' }, 400); return; }
      json(await searchMemPalace(q, wing));
      return;
    }
    if (url==='/api/memory/mine' && req.method==='POST') {
      const {target}=await readBody(req); json(await mineMemPalace(target)); return;
    }

    // ── Skills & tech stack ──────────────────────────────────────────────────
    if (url==='/api/skills') {
      json({ skills: getSkills(), software: cachedStatus?.software || [] });
      return;
    }

    // ── Logs / Control / GPU ─────────────────────────────────────────────────
    if (url==='/api/logs') {
      // Accept ?name= (preferred) or ?process= (dashboard legacy) and optional ?lines=
      const name = query.name || query.process;
      if (!name) { res.writeHead(400); res.end('Missing ?name= or ?process='); return; }
      const lines = Math.max(10, Math.min(500, parseInt(query.lines) || LOG_LINES));
      const logs = await getProcessLogs(name, lines);
      json({ name, logs });
      return;
    }
    if (url==='/api/gpu')                          { json(await getGPUInfo()); return; }
    if (url==='/api/control' && req.method==='POST')   { const {action,target}=await readBody(req); json(await controlProcess(action,target)); return; }
    if (url==='/api/lmstudio' && req.method==='POST')  { const {action}=await readBody(req); json(await controlLMStudio(action)); return; }
    if (url==='/api/resource/release' && req.method==='POST') { const {action}=await readBody(req); json(await releaseResource(action)); return; }
    if (url==='/api/resource/kill' && req.method==='POST')    { const {pid}=await readBody(req); json(await killProcess(pid)); await poll(); return; }

    // ── Principle #9: Compute / Skills / Software ──────────────────────────
    if (url==='/api/compute')       { json(await p9.buildCompute()); return; }
    if (url==='/api/skills/detail') { json(p9.buildSkillsDetail(p9SkillSources)); return; }
    if (url==='/api/software')      { json(await p9.buildSoftware(__dirname, p9Pm2Reader)); return; }

    // ── Graph RAG (Phase E.2) ────────────────────────────────────────────────
    if (url.startsWith('/api/graphrag/')) { await handleGraphrag(url, req, res, json, readBody); return; }

    res.writeHead(404); res.end('Not found');

  } catch(e) {
    console.error('Request error:', e.message);
    res.writeHead(500,{'Content-Type':'application/json'});
    res.end(JSON.stringify({error:e.message}));
  }
});

server.listen(PORT,'127.0.0.1',() => {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   AI Control Center v5                   ║');
  console.log(`║   http://localhost:${PORT}/dashboard        ║`);
  console.log('╚══════════════════════════════════════════╝');
});
process.on('SIGINT',()=>{ console.log('\nShutdown...'); process.exit(0); });
