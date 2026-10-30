# One-time setup of the Pokedex desktop app on Windows. Paste this into PowerShell:
#
#   irm https://raw.githubusercontent.com/ksotox/LLMModel/main/desktop/install.ps1 | iex
#
# It puts Pokedex.exe (built here, with the C# compiler that comes with Windows) and its launcher in
# %LOCALAPPDATA%\Pokedex, adds Desktop and Start menu shortcuts, and opens the app. The app itself
# lives in $HOME\LLMModel-main (set POKEDEX_APP_DIR first to use another folder) and updates itself
# from GitHub every time it opens. Running this again repairs or updates the setup.

function Install-Pokedex {
    $ErrorActionPreference = 'Stop'
    $repo = 'ksotox/LLMModel'
    $raw = "https://raw.githubusercontent.com/$repo/main"
    $appDir = if ($env:POKEDEX_APP_DIR) { $env:POKEDEX_APP_DIR } else { Join-Path $HOME 'LLMModel-main' }
    $installDir = Join-Path $env:LOCALAPPDATA 'Pokedex'

    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Host 'Node.js is needed first: install the LTS version from https://nodejs.org, then run this again.' -ForegroundColor Red
        return
    }
    $csc = @('Framework64', 'Framework') | ForEach-Object { Join-Path $env:WINDIR "Microsoft.NET\$_\v4.0.30319\csc.exe" } | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $csc) {
        Write-Host "Windows' C# compiler (part of .NET Framework 4) wasn't found, so Pokedex.exe can't be built." -ForegroundColor Red
        return
    }

    Write-Host "Setting up the Pokedex in $installDir ..."
    Get-Process Pokedex -ErrorAction SilentlyContinue | Stop-Process -Force  # so its files can be replaced
    New-Item -ItemType Directory -Force $installDir | Out-Null
    Invoke-WebRequest "$raw/desktop/launcher.mjs" -OutFile (Join-Path $installDir 'launcher.mjs') -UseBasicParsing
    Invoke-WebRequest "$raw/desktop/Pokedex.cs" -OutFile (Join-Path $installDir 'Pokedex.cs') -UseBasicParsing
    Invoke-WebRequest "$raw/public/pokedex.ico" -OutFile (Join-Path $installDir 'pokedex.ico') -UseBasicParsing
    $config = @{ appDir = $appDir; repo = $repo; branch = 'main'; port = 3000 } | ConvertTo-Json
    [IO.File]::WriteAllText((Join-Path $installDir 'config.json'), $config)  # UTF-8 without a BOM

    $exe = Join-Path $installDir 'Pokedex.exe'
    $ico = Join-Path $installDir 'pokedex.ico'
    & $csc /nologo /target:winexe /optimize "/out:$exe" "/win32icon:$ico" /r:System.Windows.Forms.dll (Join-Path $installDir 'Pokedex.cs')
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $exe)) {
        Write-Host 'Building Pokedex.exe failed (see the messages above).' -ForegroundColor Red
        return
    }

    $shell = New-Object -ComObject WScript.Shell
    foreach ($folder in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
        $link = $shell.CreateShortcut((Join-Path $folder 'Pokedex.lnk'))
        $link.TargetPath = $exe
        $link.WorkingDirectory = $installDir
        $link.IconLocation = $ico
        $link.Description = 'My Pokedex card collection'
        $link.Save()
    }

    Write-Host "Done. Opening the Pokedex: the first start downloads the latest version into $appDir (a minute or two)." -ForegroundColor Green
    Write-Host 'From now on, open it from the Pokedex icon on your Desktop or in the Start menu.'
    Start-Process $exe
}

Install-Pokedex
