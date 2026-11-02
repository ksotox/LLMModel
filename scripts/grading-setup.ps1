# Experimental pre-grading: one-time setup on Windows. Run from anywhere:
#   powershell -ExecutionPolicy Bypass -File scripts\grading-setup.ps1
# Downloads the MIT-licensed Viridian source (Dylan Roberts) into third_party\viridian at the
# commit this app was tested with, and installs its Python packages into .venv-grading.
# Needs Git and Python 3.10 or newer. Nothing here touches your collection.
$ErrorActionPreference = 'Stop'
$ViridianCommit = 'f22ec116a727dc3d0976e304eb28ad83c89d681b'   # pinned; see docs/SOURCES.md
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git is required: install it from https://git-scm.com and run this again.' }
$dir = 'third_party/viridian'
if (-not (Test-Path "$dir/.git")) {
  New-Item -ItemType Directory -Force $dir | Out-Null
  git -C $dir init -q
  git -C $dir remote add origin https://github.com/dylan7077/viridian.git
}
git -C $dir fetch -q --depth 1 origin $ViridianCommit
if ($LASTEXITCODE -ne 0) { throw 'Could not download Viridian.' }
git -C $dir checkout -q --force FETCH_HEAD
if (-not (Test-Path "$dir/LICENSE")) { throw 'The Viridian MIT license file is missing.' }
if (-not (Test-Path '.venv-grading/Scripts/python.exe')) {
  if (Get-Command py -ErrorAction SilentlyContinue) { py -3 -m venv '.venv-grading' } else { python -m venv '.venv-grading' }
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the Python environment. Install Python 3.10+ from https://python.org (tick "Add to PATH").' }
}
& '.venv-grading/Scripts/python.exe' -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"
if ($LASTEXITCODE -ne 0) { throw 'Python 3.10 or newer is needed. Delete the .venv-grading folder, install a newer Python, and run this again.' }
& '.venv-grading/Scripts/python.exe' -m pip install --disable-pip-version-check -q -r 'services/grading/requirements.txt'
if ($LASTEXITCODE -ne 0) { throw 'Installing the Python packages failed.' }
Write-Host ''
Write-Host 'Pre-grading is set up. Start it with: powershell -ExecutionPolicy Bypass -File scripts\grading-start.ps1' -ForegroundColor Green
Write-Host 'Viridian is MIT-licensed (c) 2026 Dylan Roberts: see third_party\viridian\LICENSE.'
