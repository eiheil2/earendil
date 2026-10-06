# pi coding agent installer (Windows).
# Mirror of scripts/install.sh — see that file for the contract.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 [-Source|-Binary]
#     [-Version <v>] [-Ref <ref>] [-Uninstall] [-Yes] [-Prefix <dir>] [-Help]
param(
	[switch]$Source,
	[switch]$Binary,
	[string]$Version = "",
	[string]$Ref = "",
	[switch]$Uninstall,
	[switch]$Yes,
	[string]$Prefix = $(if ($env:PI_INSTALL_DIR) { $env:PI_INSTALL_DIR } else { Join-Path $HOME ".local\bin" }),
	[switch]$Help
)

$ErrorActionPreference = "Stop"
$Repo = if ($env:PI_REPO) { $env:PI_REPO } else { "earendil-works/pi" }
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Split-Path -Parent $ScriptDir

if ($Help) {
	@"
Usage: powershell -File scripts\install.ps1 [-Source|-Binary] [-Version <v>] [-Ref <ref>]
                                            [-Uninstall] [-Yes] [-Prefix <dir>] [-Help]

  -Source     Install from the local source archive (offline; default in a checkout)
  -Binary     Download the prebuilt binary from GitHub releases
  -Version    Release version to install (binary mode; default: latest)
  -Ref        Git ref for a source clone
  -Uninstall  Remove the installed launcher, completions, and binary
  -Yes        Skip the interactive uninstall confirmation
  -Prefix     Install destination (default: `$PI_INSTALL_DIR or ~/.local/bin)
"@
	exit 0
}

$Manifest = Join-Path $Prefix ".pi-install-manifest"

if ($Uninstall) {
	$targets = if (Test-Path $Manifest) { Get-Content $Manifest | Where-Object { $_ -ne "" } } else { @(Join-Path $Prefix "pi.cmd"), (Join-Path $Prefix "pi.exe") }
	Write-Host "The following will be removed:"
	foreach ($t in $targets) { Write-Host "  $t" }
	Write-Host ""
	if (-not $Yes) {
		$answer = Read-Host "Proceed with uninstall? [y/N]"
		if ($answer -notmatch '^(y|Y|yes|YES)$') {
			Write-Host "Uninstall aborted."
			exit 1
		}
	}
	foreach ($t in $targets) {
		if (Test-Path $t) { Remove-Item -Force $t; Write-Host "removed $t" }
	}
	if (Test-Path $Manifest) { Remove-Item -Force $Manifest }
	Write-Host ""
	Write-Host "Uninstall complete."
	Write-Host "Your configuration, credentials, sessions, and installed packages are"
	$preservedDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $HOME ".pi/agent" }
	Write-Host "preserved in $preservedDir and were NOT removed."
	Write-Host "Delete that directory yourself if you want a full reset."
	exit 0
}

$Mode = if ($Source) { "source" } elseif ($Binary) { "binary" } else { "" }
if (-not $Mode) {
	$Mode = if (Test-Path (Join-Path $RootDir "packages\coding-agent\package.json")) { "source" } else { "binary" }
	if ($Ref -and $Mode -eq "binary" -and (Test-Path (Join-Path $RootDir "packages\coding-agent\package.json"))) {
		$Mode = "source"
	}
}

if ($Mode -eq "source") {
	if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
		Write-Error "node >= 22.19 is required for a source install"
		exit 1
	}
	$tree = $RootDir
	if (-not (Test-Path (Join-Path $tree "packages\coding-agent\src\cli.ts"))) {
		if ($Ref) {
			$tmp = New-Item -ItemType Directory -Path (Join-Path ([System.IO.Path]::GetTempPath()) ("pi-src-" + [guid]::NewGuid().ToString("N")))
			Write-Host "Cloning $Repo@$Ref..."
			git clone --depth 1 --branch $Ref "https://github.com/$Repo.git" "$tmp" 2>$null
			if ($LASTEXITCODE -ne 0) {
				git clone "https://github.com/$Repo.git" "$tmp"
				Push-Location "$tmp"; git checkout $Ref; Pop-Location
			}
			$tree = "$tmp"
		} else {
			Write-Error "-Source requires a pi source archive, or pass -Ref to clone one."
			exit 1
		}
	}
	New-Item -ItemType Directory -Force -Path $Prefix | Out-Null
	$resolver = ([System.Uri](Join-Path $tree "packages\coding-agent\src\experimental\source-resolver.ts")).AbsoluteUri
	$cliPath = Join-Path $tree "packages\coding-agent\src\cli.ts"
	$shim = Join-Path $Prefix "pi.cmd"
	Set-Content -Path $shim -Value "@node --import `"$resolver`" `"$cliPath`" %*"
	Write-Host "Installed pi launcher to $shim (source: $tree)"
	Set-Content -Path $Manifest -Value $shim
	$PiBin = $shim
} else {
	$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
	$tag = $Version
	if (-not $tag) {
		Write-Host "Resolving latest release of $Repo..."
		$release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest"
		$tag = $release.tag_name
	}
	if (-not $tag) { Write-Error "Could not resolve latest release tag"; exit 1 }
	Write-Host "Installing pi $tag (windows-$arch)..."
	New-Item -ItemType Directory -Force -Path $Prefix | Out-Null
	$asset = "pi-windows-$arch.zip"
	$zip = Join-Path ([System.IO.Path]::GetTempPath()) "pi-$tag.zip"
	Invoke-WebRequest -Uri "https://github.com/$Repo/releases/download/$tag/$asset" -OutFile $zip
	$extract = Join-Path ([System.IO.Path]::GetTempPath()) ("pi-extract-" + [guid]::NewGuid().ToString("N"))
	Expand-Archive -Path $zip -DestinationPath $extract
	$exe = Get-ChildItem -Recurse -Filter "pi.exe" $extract | Select-Object -First 1
	if (-not $exe) { Write-Error "pi.exe not found in $asset"; exit 1 }
	$dest = Join-Path $Prefix "pi.exe"
	Copy-Item $exe.FullName $dest -Force
	Write-Host "Installed binary to $dest"
	Set-Content -Path $Manifest -Value $dest
	$PiBin = $dest
}

# Completions generated from the active command metadata via the installed launcher.
$completedPaths = @()
try {
	$bashDir = Join-Path $HOME ".bash_completion.d"
	$zshDir = Join-Path $HOME ".zsh\completions"
	$fishDir = Join-Path $(if ($env:XDG_CONFIG_HOME) { $env:XDG_CONFIG_HOME } else { Join-Path $HOME ".config" }) "fish\completions"
	New-Item -ItemType Directory -Force -Path $bashDir, $zshDir, $fishDir | Out-Null
	$bashOut = & $PiBin completions bash 2>$null
	if ($bashOut) { $bashPath = Join-Path $bashDir "pi"; Set-Content $bashPath $bashOut; $completedPaths += $bashPath }
	$zshOut = & $PiBin completions zsh 2>$null
	if ($zshOut) { $zshPath = Join-Path $zshDir "_pi"; Set-Content $zshPath $zshOut; $completedPaths += $zshPath }
	$fishOut = & $PiBin completions fish 2>$null
	if ($fishOut) { $fishPath = Join-Path $fishDir "pi.fish"; Set-Content $fishPath $fishOut; $completedPaths += $fishPath }
	if ($completedPaths.Count -gt 0) { Write-Host "Installed shell completions (bash, zsh, fish)" }
} catch {
	Write-Host "Warning: completion generation failed: $_"
}
(@(Get-Content $Manifest -ErrorAction SilentlyContinue) + $completedPaths) | Where-Object { $_ } | Set-Content $Manifest

# A05: print the real `pi --version` output, never a placeholder.
try {
	$versionOutput = & $PiBin --version 2>&1
	Write-Host ""
	Write-Host "Installed: pi $versionOutput"
} catch {
	Write-Error "installed pi launcher failed --version: $_"
	exit 1
}
Write-Host "Run 'pi' to get started."
