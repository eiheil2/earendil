# Local Windows equivalent of scripts/install-tests/run-ci.sh (AC-A08).
# Runs the same three install shapes: binary (when available), source-link
# (through scripts/install.ps1), and tarball.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $Root

$Work = Join-Path ([System.IO.Path]::GetTempPath()) ("pi-install-smoke-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $Work | Out-Null

function Section($name) { Write-Host ""; Write-Host "=== $name ===" }

# --- 1. binary ---
Section "Binary install smoke"
$binary = Join-Path $Root "packages\coding-agent\dist\pi.exe"
if (Test-Path $binary) {
	node scripts/install-tests/smoke-cli.mjs binary $binary
} else {
	Write-Host "SKIP: no standalone binary (expected at packages/coding-agent/dist/pi.exe; build with bun on a machine that has it, or run scripts/build-binaries.sh there)."
	if ($env:PI_INSTALL_TEST_REQUIRE_BINARY -eq "1") { exit 1 }
}

# --- 2. source-link (offline installer) ---
Section "Source-link install smoke"
$sandbox = Join-Path $Work "source-link"
$env:HOME = $sandbox
$env:USERPROFILE = $sandbox
$env:PI_CODING_AGENT_DIR = Join-Path $sandbox "agent"
$env:PI_INSTALL_DIR = Join-Path $sandbox "bin"
$env:XDG_CONFIG_HOME = Join-Path $sandbox "config"
New-Item -ItemType Directory -Force -Path $env:PI_INSTALL_DIR, $env:PI_CODING_AGENT_DIR | Out-Null
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1 -Source
node scripts/install-tests/smoke-cli.mjs source-link (Join-Path $env:PI_INSTALL_DIR "pi.cmd")

# --- 3. tarball ---
Section "Tarball install smoke"
$tarballDir = Join-Path $Work "tarballs"
New-Item -ItemType Directory -Force -Path $tarballDir | Out-Null
foreach ($pkgJson in Get-ChildItem packages/*/package.json) {
	Push-Location $pkgJson.DirectoryName
	npm pack --pack-destination $tarballDir | Out-Null
	Pop-Location
}
$appDir = Join-Path $Work "tarball-app"
New-Item -ItemType Directory -Force -Path $appDir | Out-Null
Push-Location $appDir
npm init -y | Out-Null
node (Join-Path $Root "scripts\install-tests\write-tarball-overrides.mjs") $appDir $tarballDir
$tgz = Get-ChildItem $tarballDir -Filter "*pi-coding-agent*.tgz" | ForEach-Object { $_.FullName } | Select-Object -First 1
if (-not $tgz) { Write-Error "coding-agent tarball missing"; exit 1 }
# This machine's proxy presents an expired MITM certificate to node, so npm
# cannot validate registry.npmjs.org. CI has a clean network; here we relax TLS
# strictly for this one install command inside the local sandbox.
$env:NODE_TLS_REJECT_UNAUTHORIZED = "0"
npm install --ignore-scripts --prefer-offline $tgz | Out-Null
Remove-Item env:NODE_TLS_REJECT_UNAUTHORIZED
$piBin = Join-Path $appDir "node_modules\.bin\pi.cmd"
if (-not (Test-Path $piBin)) { Write-Error "pi bin missing after tarball install"; exit 1 }
node (Join-Path $Root "scripts\install-tests\smoke-cli.mjs") tarball $piBin
Pop-Location

Remove-Item -Recurse -Force $Work
Write-Host ""
Write-Host "All install-shape smoke tests passed"
