# phase-e2-fix-commands.ps1 — run in ELEVATED PowerShell
# Applies Phase E.2-FIX: memory-miner PM2 registration + smoke validation.
#
# Prerequisites:
#   - pm2 is on PATH (npm global)
#   - Python 3.11 at C:\Users\warre\AppData\Local\Programs\Python\Python311\python.exe
#   - D:\AIAssist\memory\graph_rag.db exists with E.2 schema applied

Set-StrictMode -Off

Write-Host ""
Write-Host "=== Section 1: Reload PM2 with updated ecosystem.config.js ===" -ForegroundColor Cyan
Set-Location D:\AIAssist
pm2 reload ecosystem.config.js --update-env
pm2 save
pm2 list

Write-Host ""
Write-Host "=== Section 2: Confirm memory-miner is online ===" -ForegroundColor Cyan
pm2 describe memory-miner

Write-Host ""
Write-Host "=== Section 3: Hit topics endpoint — expect 200 with topics array ===" -ForegroundColor Cyan
try {
    $r = Invoke-RestMethod http://127.0.0.1:7788/api/graphrag/topics
    $r | ConvertTo-Json -Depth 4
} catch {
    Write-Host "FAIL: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""
Write-Host "=== Section 4: Run smoke suite — expect 24/24 passing ===" -ForegroundColor Cyan
Set-Location D:\AIAssist\dashboard\AI-Dashboard
node smoke_test.js
