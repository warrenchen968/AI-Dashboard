'use strict';
/**
 * services-external.js
 *
 * Builds synthetic /api/services entries for processes that are not managed
 * by PM2 but are tracked by the dashboard. Currently: LM Studio only.
 *
 * Phase D addition — keeps server.js under control by isolating the LM Studio
 * HTTP probe here. See PHASE_D_DISCOVERY.md for the chosen signal strategy.
 */

const http = require('http');

const LM_HOST    = '127.0.0.1';
const LM_PORT    = 1234;
const LM_VERSION = '0.4.12+1'; // from DISCOVERY.md; update if LM Studio upgrades

// ─── Internal: zero-dep JSON probe ───────────────────────────────────────────

function probeJson(path, timeoutMs) {
  timeoutMs = timeoutMs || 2500;
  return new Promise(resolve => {
    const req = http.request(
      { hostname: LM_HOST, port: LM_PORT, path, method: 'GET', timeout: timeoutMs },
      res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try { resolve({ ok: true, body: JSON.parse(d) }); }
          catch { resolve({ ok: true, body: null }); }
        });
      }
    );
    req.on('error',   () => resolve({ ok: false, body: null }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, body: null }); });
    req.end();
  });
}

// ─── Public: build the LM Studio service entry ───────────────────────────────

async function buildLmStudioService() {
  let models = [], loadedModelId = null, online = false, probeMethod = 'none';

  // Strategy A: /api/v0/models (LM Studio REST API, added in 0.3.6)
  // Returns ALL installed models, each with a `state` field ("loaded"|"not-loaded").
  // Also provides size_bytes, context_length, architecture for the UI sub-panel.
  const v0 = await probeJson('/api/v0/models');
  if (v0.ok && Array.isArray(v0.body?.data)) {
    online = true;
    probeMethod = 'api/v0/models';
    for (const m of v0.body.data) {
      const loaded = m.state === 'loaded';
      if (loaded && !loadedModelId) loadedModelId = m.id;
      models.push({
        id:            m.id,
        loaded,
        sizeBytes:     m.size_bytes     ?? null,
        contextLength: m.context_length ?? null,
        family:        m.architecture   ?? null,
      });
    }
  } else {
    // Strategy B: /v1/models (OpenAI-compat fallback)
    // LM Studio 0.4.x: only the currently-loaded model appears in data[].
    // data.length === 0 → nothing loaded.  data.length >= 1 → first entry is loaded.
    const v1 = await probeJson('/v1/models');
    if (v1.ok && Array.isArray(v1.body?.data)) {
      online = true;
      probeMethod = 'v1/models';
      for (const m of v1.body.data) {
        if (!loadedModelId) loadedModelId = m.id;
        models.push({ id: m.id, loaded: true, sizeBytes: null, contextLength: null, family: null });
      }
    }
  }

  return {
    // Legacy fields (unchanged shape — backward-compat with /api/quick consumers)
    id:          'lmstudio',
    name:        'LM Studio',
    type:        'external',
    icon:        '🧠',
    description: 'Local LLM server',
    status:      online ? 'online' : 'offline',
    online,

    // Phase D additions (strictly additive)
    kind:         'external',
    controllable: false,
    extras: {
      baseUrl:       `http://${LM_HOST}:${LM_PORT}`,
      version:       LM_VERSION,
      probeMethod,
      models,
      loadedModelId,
    },
  };
}

module.exports = { buildLmStudioService };
