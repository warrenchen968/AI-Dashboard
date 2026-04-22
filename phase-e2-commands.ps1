# phase-e2-commands.ps1
# Run this in an elevated PowerShell after Phase E.2 files are in place.
# Split into sections so CW can paste each block independently.
#
# Prerequisites:
#   - pm2 is on PATH (npm global)
#   - Python 3.11 is at the path used in graphrag-routes.js
#   - D:\AIAssist\memory\graph_rag.db exists (created by prior graph_store usage)

Set-StrictMode -Off

# ── Section 1: apply schema migration & verify ────────────────────────────────
Write-Host "`n=== Section 1: Schema migration ===" -ForegroundColor Cyan
$py = '"C:\Users\warre\AppData\Local\Programs\Python\Python311\python.exe"'
$script = @"
import sys
sys.path.insert(0, 'D:/AIAssist/home/graph-rag')
import sqlite3, graph_store, migrations
conn = sqlite3.connect(str(graph_store.DB_PATH))
migrations.apply_e2_schema(conn)
conn.close()
print('Migration OK — DB:', str(graph_store.DB_PATH))
"@
Invoke-Expression "$py -c `"$($script.Replace('"','\"'))`""

# ── Section 2: restart services ───────────────────────────────────────────────
Write-Host "`n=== Section 2: pm2 restart ===" -ForegroundColor Cyan
pm2 restart whatsapp-bridge
pm2 restart ai-dashboard
pm2 save
pm2 list

# ── Section 3: smoke-check topics endpoint ────────────────────────────────────
Write-Host "`n=== Section 3: topics endpoint smoke check ===" -ForegroundColor Cyan
Start-Sleep -Seconds 3

try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:7788/api/graphrag/topics' -UseBasicParsing -TimeoutSec 5
    $body = $r.Content | ConvertFrom-Json
    if ($body.topics -is [array]) {
        Write-Host "PASS — /api/graphrag/topics returned $($body.topics.Count) topic(s)" -ForegroundColor Green
    } else {
        Write-Host "FAIL — topics field is not an array" -ForegroundColor Red
    }
} catch {
    Write-Host "FAIL — $($_.Exception.Message)" -ForegroundColor Red
}

# ── Section 4: smoke-check ingest-text rejects missing topics ─────────────────
Write-Host "`n=== Section 4: ingest-text validation smoke check ===" -ForegroundColor Cyan
try {
    $body = '{"text":"hello"}' | Out-String
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:7788/api/graphrag/ingest-text' `
        -Method POST -Body $body -ContentType 'application/json' `
        -UseBasicParsing -TimeoutSec 5
    Write-Host "FAIL — expected 400, got $($r.StatusCode)" -ForegroundColor Red
} catch {
    if ($_.Exception.Response.StatusCode.value__ -eq 400) {
        Write-Host "PASS — missing topics correctly rejected with 400" -ForegroundColor Green
    } else {
        Write-Host "FAIL — unexpected status: $($_.Exception.Response.StatusCode)" -ForegroundColor Red
    }
}

Write-Host "`nPhase E.2 deployment complete." -ForegroundColor Cyan
