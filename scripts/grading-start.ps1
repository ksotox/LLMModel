# Experimental pre-grading: start the local grading service (keep this window open while you use it).
#   powershell -ExecutionPolicy Bypass -File scripts\grading-start.ps1
# It listens on 127.0.0.1:8765 only (this computer); the app talks to it, the browser never does.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root
if (-not (Test-Path '.venv-grading/Scripts/python.exe')) { throw 'Run scripts\grading-setup.ps1 first.' }
& '.venv-grading/Scripts/python.exe' -m uvicorn services.grading.app:app --host 127.0.0.1 --port 8765
