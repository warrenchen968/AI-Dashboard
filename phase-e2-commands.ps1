# phase-e2-commands.ps1
# Run in an elevated PowerShell after Phase E.2 files are in place.
# Split into four sections - paste each block independently if preferred.
#
# Prerequisites:
#   - pm2 is on PATH (npm global)
#   - Python 3.11 at path below
#   - D:\AIAssist\memory\graph_rag.db exists

Set-StrictMode -Off

$PY = 'C:\Users\warre\AppData\Local\Programs\Python\Python311\python.exe'

# -- Section 1: apply schema migration --------------------------------------------
Write-Host ""
Write-Host "=== Section 1: Schema migration ===" -ForegroundColor Cyan

$migScript = @'
import sys
sys.path.insert(0, 'D:/AIAssist/home/graph-rag')
import sqlite3, graph_store, migrations
conn = sqlite3.connect(str(graph_store.DB_PATH))
migrations.apply_e2_schema(conn)
conn.close()
print('Migration OK - DB: ' + str(graph_store.DB_PATH))
'@

$tmpPy = [System.IO.Path]::GetTempFileName() + '.py'
$migScript | Out-File -FilePath $tmpPy -Encoding utf8
& $PY $tmpPy
Remove-Item $tmpPy -Force

# -- Section 2: restart services --------------------------------------------------
Write-Host ""
Write-Host "=== Section 2: pm2 restart ===" -ForegroundColor Cyan
pm2 restart whatsapp-bridge
pm2 restart ai-dashboard
pm2 save
pm2 list

# -- Section 3: smoke-check topics endpoint ---------------------------------------
Write-Host ""
Write-Host "=== Section 3: topics endpoint smoke check ===" -ForegroundColor Cyan
Start-Sleep -Seconds 3

try {
    $resp3 = Invoke-WebRequest -Uri 'http://127.0.0.1:7788/api/graphrag/topics' `
        -UseBasicParsing -TimeoutSec 5
    $data3 = $resp3.Content | ConvertFrom-Json
    if ($data3.topics -is [array]) {
        Write-Host "PASS - /api/graphrag/topics returned $($data3.topics.Count) topic(s)" -ForegroundColor Green
    } else {
        Write-Host "FAIL - topics field is not an array" -ForegroundColor Red
    }
} catch {
    Write-Host "FAIL - $($_.Exception.Message)" -ForegroundColor Red
}

# -- Section 4: smoke-check ingest-text rejects missing topics --------------------
Write-Host ""
Write-Host "=== Section 4: ingest-text validation smoke check ===" -ForegroundColor Cyan

$payload4 = '{"text":"hello"}'
try {
    $resp4 = Invoke-WebRequest -Uri 'http://127.0.0.1:7788/api/graphrag/ingest-text' `
        -Method POST `
        -Body $payload4 `
        -ContentType 'application/json' `
        -UseBasicParsing `
        -TimeoutSec 5
    Write-Host "FAIL - expected 400, got $($resp4.StatusCode)" -ForegroundColor Red
} catch {
    $code4 = $null
    if ($_.Exception.Response) {
        $code4 = [int]$_.Exception.Response.StatusCode
    }
    if ($code4 -eq 400) {
        Write-Host "PASS - missing topics correctly rejected with 400" -ForegroundColor Green
    } else {
        Write-Host "FAIL - unexpected status: $code4" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "Phase E.2 deployment complete." -ForegroundColor Cyan
