# Principle #9 — API Contracts

These are the JSON shapes the new frontend panels depend on. **Do not change a field name or type without updating `smoke_test.js` in the same commit.** Field drift between `server.js` and `dashboard.html` was the root cause of the original 10-bug batch; treat this file as the source of truth.

Units: memory in MB, disk in GB, durations in seconds, timestamps ISO-8601 UTC.

---

## GET `/api/compute`

Extended compute snapshot (superset of `/api/quick.system`). Safe to call once per second.

```json
{
  "at": "2026-04-18T14:30:00.000Z",
  "cpu": { "pct": 42.1, "cores": 8, "load1": 1.3 },
  "ram": { "pct": 67.3, "usedMB": 20832, "totalMB": 30960, "freeMB": 10128 },
  "gpu": {
    "available": true,
    "name": "NVIDIA RTX 4060",
    "utilPct": 31,
    "memUsedMB": 4210,
    "memTotalMB": 8192
  },
  "disks": [
    { "mount": "C:", "usedGB": 213.4, "totalGB": 476.9, "pct": 44.7 }
  ],
  "uptimeSec": 1234567
}
```

When no GPU is detected:
```json
"gpu": { "available": false, "reason": "nvidia-smi not found" }
```

Frontend **must** render `—` for any missing field rather than crash. Use `?.` everywhere.

---

## GET `/api/skills/detail`

Enumerates skills across Claude Code's three skill directories.

```json
{
  "at": "2026-04-18T14:30:00.000Z",
  "totalCount": 17,
  "sources": [
    {
      "label": "Project skills",
      "path": "C:\\AI-Assistant\\.claude\\skills",
      "exists": true,
      "skills": [
        {
          "name": "frontend-design",
          "description": "UI/UX quality enforcement for frontend code",
          "path": "C:\\AI-Assistant\\.claude\\skills\\frontend-design\\SKILL.md",
          "bytes": 12430,
          "modifiedAt": "2026-04-14T10:39:00.000Z",
          "hasFrontmatter": true
        }
      ]
    }
  ]
}
```

A skill is any directory containing a `SKILL.md`. `description` is parsed from YAML frontmatter; if absent, falls back to the first non-empty line of the file. Skills are sorted alphabetically within each source.

---

## GET `/api/software`

Dependency-ordered software inventory (Principle #9 item 3: 软件清单). The server reads `software-manifest.json` (colocated with `server.js`) and runs the configured health check for each item.

```json
{
  "at": "2026-04-18T14:30:00.000Z",
  "items": [
    {
      "order": 1,
      "layer": "Runtime",
      "name": "Node.js",
      "purpose": "JS runtime for dashboard + bridges",
      "status": "ok",
      "version": "v20.11.1",
      "detail": "",
      "prerequisites": [],
      "check": { "kind": "cmd", "cmd": "node --version" }
    }
  ]
}
```

`status` is one of:
- `ok` — check succeeded and reported healthy
- `missing` — check couldn't locate the software (command not found, port not open)
- `degraded` — check reached the software but got a non-healthy response
- `unknown` — check type unrecognized or timed out

`check.kind` is one of:
- `cmd` — shell command; `ok` if exit 0, version parsed from first line of stdout
- `http` — GET; `ok` on 2xx within 2s
- `pm2` — read PM2 process list; `ok` if named process is `online`
- `self` — always `ok` (the dashboard itself)

Items sorted by `order` (ascending). Users edit `software-manifest.json` to add/remove/reorder.
