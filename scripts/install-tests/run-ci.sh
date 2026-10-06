#!/usr/bin/env bash
# Install-shape smoke CI leg (AC-A08).
#
# Exercises at least three install shapes locally/locally-in-CI:
#   1. binary       — a standalone `pi` executable (when available)
#   2. source-link  — the launcher scripts/install.sh writes (offline)
#   3. tarball      — npm-packed tarballs installed into a fresh project
#
# Every shape runs the same smoke: --version, --help, one real offline
# session, one mock-provider session, completions. The binary shape is
# skipped with a printed reason when no executable can be produced (no bun);
# set PI_INSTALL_TEST_REQUIRE_BINARY=1 to make that a failure instead.
#
# Local equivalent on Windows: scripts/install-tests/run-local.ps1
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT_DIR="$(pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

SMOKE="node $ROOT_DIR/scripts/install-tests/smoke-cli.mjs"

section() { echo; echo "=== $1 ==="; }

# --- 1. binary -------------------------------------------------------------
section "Binary install smoke"
BINARY=""
if [ -x "$ROOT_DIR/packages/coding-agent/dist/pi" ]; then
	BINARY="$ROOT_DIR/packages/coding-agent/dist/pi"
elif command -v bun >/dev/null 2>&1 && [ -f "$ROOT_DIR/packages/coding-agent/dist/bun/cli.js" ]; then
	( cd "$ROOT_DIR/packages/coding-agent" &&
		bun build --compile --no-compile-autoload-bunfig ./dist/bun/cli.js ./src/utils/image-resize-worker.ts ./src/extensions/codemode/worker.ts --outfile dist/pi &&
		npm run copy-binary-assets )
	BINARY="$ROOT_DIR/packages/coding-agent/dist/pi"
fi
if [ -n "$BINARY" ]; then
	$SMOKE binary "$BINARY"
else
	echo "SKIP: no standalone pi binary available (install bun or set up dist/pi)."
	if [ "${PI_INSTALL_TEST_REQUIRE_BINARY:-0}" = "1" ]; then exit 1; fi
fi

# --- 2. source-link (offline installer) -------------------------------------
section "Source-link install smoke"
export SANDBOX="$WORK_DIR/source-link"
mkdir -p "$SANDBOX/bin" "$SANDBOX/agent"
(
	export HOME="$SANDBOX"
	export PI_CODING_AGENT_DIR="$SANDBOX/agent"
	export PI_INSTALL_DIR="$SANDBOX/bin"
	export XDG_CONFIG_HOME="$SANDBOX/config"
	sh "$ROOT_DIR/scripts/install.sh" --source
)
$SMOKE source-link sh "$SANDBOX/bin/pi"

# --- 3. tarball --------------------------------------------------------------
section "Tarball install smoke"
TARBALL_DIR="$WORK_DIR/tarballs"
mkdir -p "$TARBALL_DIR"
for pkg_dir in "$ROOT_DIR"/packages/*/; do
	( cd "$pkg_dir" && npm pack --pack-destination "$TARBALL_DIR" >/dev/null )
done
APP_DIR="$WORK_DIR/tarball-app"
mkdir -p "$APP_DIR"
cd "$APP_DIR"
npm init -y >/dev/null
TGZS=("$TARBALL_DIR"/*.tgz)
AGENT_TGZ="$(ls "$TARBALL_DIR"/*pi-coding-agent*.tgz | head -1)"
# Point workspace deps at the packed tarballs instead of the registry.
node "$ROOT_DIR/scripts/install-tests/write-tarball-overrides.mjs" "$APP_DIR" "$TARBALL_DIR"
npm install --ignore-scripts --prefer-offline "$AGENT_TGZ" >/dev/null
if [ ! -x node_modules/.bin/pi ]; then
	echo "FAIL: node_modules/.bin/pi missing after tarball install"
	exit 1
fi
$SMOKE tarball "$APP_DIR/node_modules/.bin/pi"
cd "$ROOT_DIR"

echo
echo "All install-shape smoke tests passed"
