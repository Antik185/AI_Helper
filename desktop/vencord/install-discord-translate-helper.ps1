param(
    [ValidateSet("auto", "stable", "ptb", "canary")]
    [string] $Discord = "stable",

    [string] $VencordDir = "E:\Vencord",

    [switch] $NoUpdate,
    [switch] $SkipInject
)

$ErrorActionPreference = "Stop"

function Write-Step([string] $Text) {
    Write-Host ""
    Write-Host "==> $Text" -ForegroundColor Cyan
}

function Write-Ok([string] $Text) {
    Write-Host "OK: $Text" -ForegroundColor Green
}

function Write-Warn([string] $Text) {
    Write-Host "WARN: $Text" -ForegroundColor Yellow
}

function Require-Command([string] $Name, [string] $InstallHint) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name is not installed or not in PATH. $InstallHint"
    }
}

function Run([string] $File, [string[]] $Args, [string] $Cwd = $PWD.Path) {
    Write-Host "> $File $($Args -join ' ')" -ForegroundColor DarkGray
    Push-Location $Cwd
    try {
        & $File @Args
        if ($LASTEXITCODE -ne 0) {
            throw "Command failed with exit code ${LASTEXITCODE}: $File $($Args -join ' ')"
        }
    } finally {
        Pop-Location
    }
}

function Get-DiscordInstallPath([string] $Kind) {
    $local = [Environment]::GetFolderPath("LocalApplicationData")
    $candidates = switch ($Kind) {
        "stable" { @("Discord") }
        "ptb"    { @("DiscordPTB") }
        "canary" { @("DiscordCanary") }
        default  { @("Discord", "DiscordPTB", "DiscordCanary") }
    }

    foreach ($name in $candidates) {
        $path = Join-Path $local $name
        if (Test-Path $path) {
            return $path
        }
    }

    return $null
}

function Ensure-Pnpm() {
    if (Get-Command pnpm -ErrorAction SilentlyContinue) {
        Write-Ok "pnpm found"
        return
    }

    Write-Step "Installing pnpm"
    Require-Command "npm" "Install Node.js LTS from https://nodejs.org/ first."
    Run "npm" @("install", "-g", "pnpm")
}

function Ensure-Vencord([string] $Dir) {
    if (Test-Path $Dir) {
        if (-not (Test-Path (Join-Path $Dir ".git"))) {
            throw "VencordDir exists but is not a git repository: $Dir"
        }

        if (-not $NoUpdate) {
            Write-Step "Updating Vencord"
            Run "git" @("pull", "--ff-only") $Dir
        } else {
            Write-Warn "Skipping Vencord update because -NoUpdate was passed"
        }
        return
    }

    Write-Step "Cloning Vencord"
    $parent = Split-Path -Parent $Dir
    if ($parent -and -not (Test-Path $parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    Run "git" @("clone", "https://github.com/Vendicated/Vencord.git", $Dir)
}

function Copy-Plugin([string] $VencordRoot) {
    $source = Join-Path $PSScriptRoot "DiscordTranslateHelper"
    if (-not (Test-Path (Join-Path $source "index.tsx"))) {
        throw "Plugin source not found: $source"
    }
    if (-not (Test-Path (Join-Path $source "native.ts"))) {
        throw "Plugin native.ts not found: $source"
    }

    $userplugins = Join-Path $VencordRoot "src\userplugins"
    $target = Join-Path $userplugins "DiscordTranslateHelper"

    New-Item -ItemType Directory -Force -Path $target | Out-Null

    $resolvedTarget = (Resolve-Path $target).Path
    if ($resolvedTarget -notmatch "\\src\\userplugins\\DiscordTranslateHelper$") {
        throw "Refusing to clean unexpected plugin target: $resolvedTarget"
    }

    Get-ChildItem -LiteralPath $target -Force | Remove-Item -Recurse -Force
    Copy-Item -Path (Join-Path $source "*") -Destination $target -Recurse -Force

    Write-Ok "Plugin copied to $target"
}

function Build-Vencord([string] $Dir) {
    Write-Step "Installing Vencord dependencies"
    Run "pnpm" @("install") $Dir

    Write-Step "Building Vencord with DiscordTranslateHelper"
    Run "pnpm" @("build") $Dir
}

function Inject-Vencord([string] $Dir, [string] $DiscordKind) {
    if ($SkipInject) {
        Write-Warn "Skipping injection because -SkipInject was passed"
        return
    }

    $discordPath = Get-DiscordInstallPath $DiscordKind
    if ($discordPath) {
        Write-Ok "Detected Discord install: $discordPath"
    } else {
        Write-Warn "Could not auto-detect Discord install for '$DiscordKind'. Vencord installer may ask you to choose it."
    }

    Write-Step "Injecting Vencord into Discord"
    Write-Host "If the Vencord installer asks what to install into, choose Discord Stable unless you intentionally use PTB/Canary." -ForegroundColor Yellow
    Run "pnpm" @("inject") $Dir
}

Write-Host "Discord Translate Helper - Vencord installer" -ForegroundColor Magenta
Write-Host "This script installs the Vencord userplugin into the Discord desktop app." -ForegroundColor Magenta

Write-Step "Checking tools"
Require-Command "git" "Install Git for Windows from https://git-scm.com/downloads."
Require-Command "node" "Install Node.js LTS 20+ from https://nodejs.org/."
Require-Command "npm" "Install Node.js LTS 20+ from https://nodejs.org/."
Ensure-Pnpm

Write-Step "Preparing Vencord"
Ensure-Vencord $VencordDir

Write-Step "Copying plugin"
Copy-Plugin $VencordDir

Build-Vencord $VencordDir
Inject-Vencord $VencordDir $Discord

Write-Step "Done"
Write-Host "Restart Discord, then open: User Settings -> Vencord -> Plugins -> DiscordTranslateHelper -> Enable." -ForegroundColor Green
Write-Host "For the first test, use Google Translate provider because it does not require an API key." -ForegroundColor Green
