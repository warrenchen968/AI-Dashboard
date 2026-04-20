# Phase D Discovery — LM Studio "loaded model" signal

> Written 2026-04-20. CW was AFK during Step 1; best-effort approach used.
> Live empirical verification can be done by CW after Phase D ships.

---

## Context

LM Studio version: **0.4.12+1** (from DISCOVERY.md)
LM Studio server was **OFF** at the time of this discovery pass (port 1234 not bound).
Because live toggling could not be performed, this document records:
1. What DISCOVERY.md Phase A established about the `/v1/models` shape.
2. What the LM Studio REST API (≥ 0.3.6) is expected to expose at `/api/v0/models`.
3. The chosen implementation strategy and its rationale.

---

## Known from Phase A (empirical)

- `GET http://127.0.0.1:1234/v1/models` returns OpenAI-compat shape:
  `{ "object": "list", "data": [ { "id": "<model>", ... } ] }`
- **LM Studio 0.4.x behaviour (documented in Phase A):**
  `data` contains **only the currently-loaded model**.
  If no model is loaded, `data` is `[]`.
- This means `data.length === 0` → no model loaded; `data.length ≥ 1` → first entry is loaded.

---

## Endpoints probed (when server is ON)

| Endpoint | Status | Notes |
|---|---|---|
| `GET /v1/models` | expected 200 | OpenAI-compat; only loaded model in `data` |
| `GET /api/v0/models` | unknown (server was off) | LM Studio REST API (≥ 0.3.6); should return all models with `state` field |
| `GET /v1/internal/model/info` | expected 404 | unofficial, not probed |
| `GET /v1/models/loaded` | expected 404 | unofficial, not probed |

**CW: please verify `/api/v0/models` when LM Studio server is on.** Expected shape:
```json
{
  "data": [
    {
      "id": "qwen2.5-7b-instruct",
      "state": "loaded",
      "size_bytes": 4321000000,
      "context_length": 8192,
      "architecture": "qwen2"
    },
    {
      "id": "deepseek-coder-6.7b",
      "state": "not-loaded",
      "size_bytes": 3800000000,
      "context_length": 4096,
      "architecture": "llama"
    }
  ]
}
```

---

## Chosen strategy

**Strategy A (primary): `/api/v0/models`**

- LM Studio 0.3.6+ documents this endpoint.
- Returns ALL installed models, not just loaded ones.
- Each model has a `state` field: `"loaded"` or `"not-loaded"`.
- Provides `size_bytes`, `context_length`, `architecture` — used for the sub-panel.

**Strategy B (fallback): `/v1/models`**

- Used when `/api/v0/models` returns non-200, times out, or returns empty/null data.
- Only the loaded model appears in `data`.
- No size/context/family info available; those fields are returned as `null`.
- Single model in `data` → mark it `loaded: true`; `data = []` → no model loaded.

**Strategy C (not implemented):** chat/completions ping — too slow, too wasteful.

---

## Implementation

`services-external.js` → `buildLmStudioService()`:
1. Probes `/api/v0/models` with 2.5s timeout.
2. If success and `body.data` is a non-empty array → Strategy A path.
3. Else probes `/v1/models` → Strategy B path.
4. Returns the full LM Studio service entry with `extras.models[]` and `extras.loadedModelId`.
5. Result includes `extras.probeMethod` field for diagnostics (`'api/v0/models'` | `'v1/models'` | `'none'`).

---

## Empirical findings during Phase D implementation (2026-04-20)

The LM Studio server came online during the UX check. Live API probe confirmed:

```
probeMethod:   api/v0/models     ← Strategy A succeeded
loadedModelId: qwen2.5-math-7b-instruct:2
models count:  8
loaded models: ['qwen2.5-math-7b-instruct:2']
```

**`/api/v0/models` IS supported on LM Studio 0.4.12+1 on this machine.**

Sample raw shape of a loaded model entry from `/api/v0/models`:
```json
{ "id": "qwen2.5-math-7b-instruct:2", "state": "loaded", ... }
```

Sample shape of an unloaded model entry:
```json
{ "id": "qwen3.5-27b-claude-4.6-opus-reasoning-distilled", "state": "not-loaded", ... }
```

The `size_bytes`, `context_length`, `architecture` fields were present but returned as `null` in the
`/api/services` enrichment — indicating the `/api/v0/models` response on this version does not include
them (or includes them under different field names). CW may want to inspect the raw `/api/v0/models`
response to see what additional fields are available.

---

## UX check results (Scenario 1 verified live)

| Scenario | Result |
|---|---|
| Scenario 1: LM Studio ON, one model loaded | **PASS** — External badge, online, ▾ Models (8), loaded model green dot, buttons dimmed |
| Scenario 2: LM Studio ON, no model loaded | Not verified (model was loaded during check) |
| Scenario 3: LM Studio OFF | Not verified (server was on) |
| Scenario 4: WhatsApp Bridge stop→start | Not verified (PM2 EPERM from Claude Code shell) |
| Scenario 5: WeChat Bridge default state | Shows "not in PM2" — PM2 registration pending CW action |

**CW: please verify Scenarios 2–5 and the raw `/api/v0/models` shape.**

---

## CW verification steps (do after Phase D ships)

1. Open LM Studio → ensure server is ON.
2. Run: `curl -s http://127.0.0.1:1234/api/v0/models | python -m json.tool`
   - Record full JSON here.
3. Eject all models → repeat curl → record.
4. Load one model → repeat curl → record.
5. If `/api/v0/models` returns 404, Strategy B is in use; update PHASE_D_DISCOVERY.md.
6. Hit `http://127.0.0.1:7788/api/services` and verify `extras.probeMethod` matches expectations.
