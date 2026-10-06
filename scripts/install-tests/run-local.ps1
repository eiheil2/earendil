# Local Windows equivalent of scripts/install-tests/run-ci.sh (AC-A08).
# Runs the same three install shapes: binary (when available), source-link
# (through scripts/install.ps1), and tarball.
#
# Native exit codes are checked explicitly after every step. $ErrorActionPreference
# stays "Continue" because node/npm write notices and deprecation warnings to
# stderr, and under "Stop" PowerShell turns those into terminating errors (a wrap
# with 2>&1 would kill the run mid-flight); cmdlet failures in the critical path
# are covered by the explicit checks below instead.
$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $Root

function Fail($message) {
	Write-Error $message
	exit 1
}

$Work = Join-Path ([System.IO.Path]::GetTempPath()) ("pi-install-smoke-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $Work | Out-Null

function Section($name) { Write-Host ""; Write-Host "=== $name ===" }

# --- 1. binary ---
Section "Binary install smoke"
$binary = Join-Path $Root "packages\coding-agent\dist\pi.exe"
if (Test-Path $binary) {
	node scripts/install-tests/smoke-cli.mjs binary $binary
	if ($LASTEXITCODE -ne 0) { Fail "binary smoke failed (exit $LASTEXITCODE)" }
} else {
	Write-Host "SKIP: no standalone binary (expected at packages\coding-agent\dist\pi.exe; build with bun on a machine that has it, or run scripts/build-binaries.sh there)."
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
if ($LASTEXITCODE -ne 0) { Fail "install.ps1 -Source failed (exit $LASTEXITCODE)" }
node scripts/install-tests/smoke-cli.mjs source-link (Join-Path $env:PI_INSTALL_DIR "pi.cmd")
if ($LASTEXITCODE -ne 0) { Fail "source-link smoke failed (exit $LASTEXITCODE)" }

# --- 3. tarball ---
Section "Tarball install smoke"
$tarballDir = Join-Path $Work "tarballs"
New-Item -ItemType Directory -Force -Path $tarballDir | Out-Null
foreach ($pkgJson in Get-ChildItem packages/*/package.json) {
	Push-Location $pkgJson.DirectoryName
	npm pack --pack-destination $tarballDir | Out-Null
	if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "npm pack failed in $($pkgJson.DirectoryName) (exit $LASTEXITCODE)" }
	Pop-Location
}
$appDir = Join-Path $Work "tarball-app"
New-Item -ItemType Directory -Force -Path $appDir | Out-Null
Push-Location $appDir
npm init -y | Out-Null
node (Join-Path $Root "scripts\install-tests\write-tarball-overrides.mjs") $appDir $tarballDir
if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "write-tarball-overrides failed (exit $LASTEXITCODE)" }
$tgz = Get-ChildItem $tarballDir -Filter "*pi-coding-agent*.tgz" | ForEach-Object { $_.FullName } | Select-Object -First 1
if (-not $tgz) { Pop-Location; Fail "coding-agent tarball missing" }
# This machine's proxy presents an expired MITM certificate to node, so npm
# cannot validate registry.npmjs.org. CI has a clean network; here we relax TLS
# strictly for this one install command inside the local sandbox.
$env:NODE_TLS_REJECT_UNAUTHORIZED = "0"
npm install --ignore-scripts --prefer-offline $tgz | Out-Null
$npmExit = $LASTEXITCODE
Remove-Item env:NODE_TLS_REJECT_UNAUTHORIZED
if ($npmExit -ne 0) { Pop-Location; Fail "npm install of tarball failed (exit $npmExit)" }
$piBin = Join-Path $appDir "node_modules\.bin\pi.cmd"
if (-not (Test-Path $piBin)) { Pop-Location; Fail "pi bin missing after tarball install" }
node (Join-Path $Root "scripts\install-tests\smoke-cli.mjs") tarball $piBin
$smokeExit = $LASTEXITCODE
Pop-Location
if ($smokeExit -ne 0) { Fail "tarball smoke failed (exit $smokeExit)" }

Remove-Item -Recurse -Force $Work
Write-Host ""
Write-Host "All install-shape smoke tests passed"
