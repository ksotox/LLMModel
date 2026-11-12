# Moves your collection from this PC to your Pokédex cloud server (README: "Run it in the cloud
# for free"). Close the Pokedex app on this PC first, then paste this into PowerShell:
#
#   irm https://raw.githubusercontent.com/ksotox/LLMModel/main/scripts/cloud-move.ps1 | iex
#
# It copies your app folder's data\ (cards, photos, settings) to the server, over Tailscale. What
# the server had before is kept there as LLMModel-main.data-before-move-<date>, and your PC's copy
# isn't changed. Optional settings, set first: $env:POKEDEX_CLOUD (the server's Tailscale name,
# default "pokedex"), $env:POKEDEX_CLOUD_USER (default "ubuntu"), $env:POKEDEX_APP_DIR.

function Move-PokedexToCloud {
    $ErrorActionPreference = 'Stop'
    $server = if ($env:POKEDEX_CLOUD) { $env:POKEDEX_CLOUD } else { 'pokedex' }
    $user = if ($env:POKEDEX_CLOUD_USER) { $env:POKEDEX_CLOUD_USER } else { 'ubuntu' }
    $appDir = if ($env:POKEDEX_APP_DIR) { $env:POKEDEX_APP_DIR } else { Join-Path $HOME 'LLMModel-main' }
    $data = Join-Path $appDir 'data'
    $target = "$user@$server"

    if (-not (Test-Path (Join-Path $data 'collection.db'))) {
        Write-Host "No collection found in $data. Set `$env:POKEDEX_APP_DIR to your app folder first." -ForegroundColor Red
        return
    }
    try {
        Invoke-WebRequest 'http://localhost:3000/api/meta' -UseBasicParsing -TimeoutSec 2 | Out-Null
        Write-Host 'The Pokedex is still running on this PC: close its window first, so the collection is complete.' -ForegroundColor Red
        return
    } catch { }  # not running: good
    if (-not (Get-Command ssh -ErrorAction SilentlyContinue) -or -not (Get-Command scp -ErrorAction SilentlyContinue)) {
        Write-Host "Windows' OpenSSH client is needed: Settings > System > Optional features > Add 'OpenSSH Client'." -ForegroundColor Red
        return
    }

    Write-Host "Connecting to $target (if a link appears, open it to approve this PC)..."
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    ssh $target "sudo systemctl stop pokedex && if [ -d ~/LLMModel-main/data ]; then mv ~/LLMModel-main/data ~/LLMModel-main.data-before-move-$stamp; fi"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Couldn't reach $target. Is Tailscale connected on this PC, and was cloud-setup.sh run on the server?" -ForegroundColor Red
        return
    }
    Write-Host "Copying $data (photos can take a while)..."
    scp -r $data "${target}:LLMModel-main/data"
    $copied = $LASTEXITCODE -eq 0
    ssh $target 'sudo systemctl start pokedex'
    if (-not $copied) {
        Write-Host "The copy didn't finish. Run this again; the server kept its earlier collection in ~/LLMModel-main.data-before-move-$stamp." -ForegroundColor Red
        return
    }
    Write-Host 'Done: your collection is on the cloud server now. Open your Pokédex there and sign in as usual.' -ForegroundColor Green
    Write-Host "Your PC's copy is unchanged in $data."
}

Move-PokedexToCloud
