#!/bin/sh
# pi coding agent installer.
#
# Ships inside the source archive and works offline: with no flags it installs
# a `pi` launcher that runs the checkout's sources directly (no network, no
# global npm mutation). Flags add the online modes (prebuilt binary, specific
# version/ref) and the uninstall path.
#
# Usage:
#   sh scripts/install.sh [--source|--binary] [--version <v>] [--ref <ref>] [--uninstall] [--yes]
#                         [--prefix <dir>] [--help]
#
# Env:
#   PI_INSTALL_DIR   Launcher destination (default: ~/.local/bin)
#   PI_REPO          GitHub owner/repo for binary downloads (default: earendil-works/pi)
set -eu

MODE=""
VERSION=""
REF=""
UNINSTALL=0
ASSUME_YES=0
PREFIX="${PI_INSTALL_DIR:-$HOME/.local/bin}"
REPO="${PI_REPO:-earendil-works/pi}"

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

usage() {
	cat <<EOF
Usage: sh scripts/install.sh [--source|--binary] [--version <v>] [--ref <ref>]
                             [--uninstall] [--yes] [--prefix <dir>] [--help]

  --source      Install from the local source archive (offline; default when run
                from a checkout)
  --binary      Download the prebuilt binary from GitHub releases
  --version <v> Release version to install (binary mode; default: latest)
  --ref <ref>   Git ref (tag/branch/commit) for --source clones
  --uninstall   Remove the installed launcher, completions, and binary.
                Interactive confirmation required unless --yes is passed.
  --yes         Skip the interactive uninstall confirmation
  --prefix <dir> Install destination (default: \$PI_INSTALL_DIR or ~/.local/bin)
EOF
}

while [ $# -gt 0 ]; do
	case "$1" in
		--source) MODE="source"; shift ;;
		--binary) MODE="binary"; shift ;;
		--version)
			[ $# -ge 2 ] || { echo "Missing value for --version" >&2; exit 1; }
			VERSION="$2"; shift 2 ;;
		--version=*) VERSION="${1#*=}"; shift ;;
		--ref)
			[ $# -ge 2 ] || { echo "Missing value for --ref" >&2; exit 1; }
			REF="$2"; shift 2 ;;
		--ref=*) REF="${1#*=}"; shift ;;
		-r)
			[ $# -ge 2 ] || { echo "Missing value for -r" >&2; exit 1; }
			REF="$2"; shift 2 ;;
		--uninstall) UNINSTALL=1; shift ;;
		--yes|-y) ASSUME_YES=1; shift ;;
		--prefix)
			[ $# -ge 2 ] || { echo "Missing value for --prefix" >&2; exit 1; }
			PREFIX="$2"; shift 2 ;;
		--prefix=*) PREFIX="${1#*=}"; shift ;;
		--help|-h) usage; exit 0 ;;
		*) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
	esac
done

log() { printf '%s\n' "$*"; }

# --- Uninstall -----------------------------------------------------------------
#
# B08: only artifacts this installer created are removed. User configuration,
# credentials, sessions, and installed extension packages (the agent dir,
# default ~/.pi/agent unless PI_CODING_AGENT_DIR overrides it) are left intact
# and the removal output says so explicitly.

MANIFEST="$PREFIX/.pi-install-manifest"

uninstall() {
	targets=""
	if [ -f "$MANIFEST" ]; then
		targets=$(cat "$MANIFEST")
	else
		targets="$PREFIX/pi"
	fi

	log "The following will be removed:"
	for path in $targets; do log "  $path"; done
	log ""
	if [ "$ASSUME_YES" -ne 1 ]; then
		printf 'Proceed with uninstall? [y/N] '
		answer=""
		if ( : </dev/tty ) 2>/dev/null; then
			read -r answer </dev/tty || answer=""
		else
			read -r answer || answer=""
		fi
		case "$answer" in
			y|Y|yes|YES) ;;
			*) log "Uninstall aborted."; exit 1 ;;
		esac
	fi

	for path in $targets; do
		if [ -e "$path" ] || [ -L "$path" ]; then
			rm -f "$path"
			log "removed $path"
		fi
	done
	rm -f "$MANIFEST"

	log ""
	log "Uninstall complete."
	log "Your configuration, credentials, sessions, and installed packages are"
	log "preserved in ${PI_CODING_AGENT_DIR:-$HOME/.pi/agent} and were NOT removed."
	log "Delete that directory yourself if you want a full reset."
}

# --- Source install ------------------------------------------------------------

source_tree() {
	# Where the pi sources live for a source-link install.
	if [ -f "$ROOT_DIR/packages/coding-agent/src/cli.ts" ]; then
		echo "$ROOT_DIR"
		return 0
	fi
	if [ -n "$REF" ]; then
		tmp=$(mktemp -d)
		trap 'rm -rf "$tmp"' EXIT
		log "Cloning $REPO@$REF..."
		if git clone --depth 1 --branch "$REF" "https://github.com/$REPO.git" "$tmp/src" 2>/dev/null; then
			:
		else
			git clone "https://github.com/$REPO.git" "$tmp/src"
			(cd "$tmp/src" && git checkout "$REF")
		fi
		echo "$tmp/src"
		return 0
	fi
	echo "error: --source requires a pi source archive (no packages/coding-agent/src/cli.ts found next to this script), or pass --ref to clone one." >&2
	return 1
}

windows_path() {
	# When running under MSYS/Git-Bash/Cygwin, node (a native Windows binary)
	# needs native C:\... paths, not /c/... POSIX ones.
	case "$(uname -s)" in
		MINGW*|MSYS*|CYGWIN*)
			if command -v cygpath >/dev/null 2>&1; then
				cygpath -w "$1"
				return
			fi
			;;
	esac
	printf '%s' "$1"
}

node_resolver_url() {
	src=$(windows_path "$1/packages/coding-agent/src/experimental/source-resolver.ts")
	# --import takes a module specifier; Windows paths are not specifiers.
	case "$src" in
		[A-Za-z]:*)
			win_src=$(printf '%s' "$src" | sed 's|\\|/|g')
			echo "file:///$win_src"
			;;
		*) echo "file://$src" ;;
	esac
}

install_source() {
	tree=$(source_tree) || exit 1
	if ! command -v node >/dev/null 2>&1; then
		echo "error: node >= 22.19 is required for a source install" >&2
		exit 1
	fi
	mkdir -p "$PREFIX"
	resolver=$(node_resolver_url "$tree")
	tree_shim=$(windows_path "$tree")
	cat > "$PREFIX/pi" <<EOF
#!/bin/sh
exec node --import "$resolver" "$tree_shim/packages/coding-agent/src/cli.ts" "\$@"
EOF
	chmod +x "$PREFIX/pi"
	log "Installed pi launcher to $PREFIX/pi (source: $tree)"
	printf '%s\n' "$PREFIX/pi" > "$MANIFEST"
}

# --- Binary install ------------------------------------------------------------

host_arch() {
	case "$(uname -m)" in
		x86_64|amd64) echo "x64" ;;
		aarch64|arm64) echo "arm64" ;;
		*) uname -m ;;
	esac
}

host_platform() {
	case "$(uname -s)" in
		Linux) echo "linux" ;;
		Darwin) echo "darwin" ;;
		*) echo "error: unsupported OS: $(uname -s)" >&2; exit 1 ;;
	esac
}

install_binary() {
	platform=$(host_platform)
	arch=$(host_arch)
	if [ -n "$VERSION" ]; then
		tag="$VERSION"
	else
		log "Resolving latest release of $REPO..."
		tag=$(curl -fsSL --connect-timeout 10 "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/' | head -1)
		[ -n "$tag" ] || { echo "error: could not resolve latest release tag" >&2; exit 1; }
	fi
	log "Installing pi $tag ($platform-$arch)..."
	mkdir -p "$PREFIX"
	tmp=$(mktemp)
	trap 'rm -f "$tmp"' EXIT
	asset="pi-$platform-$arch"
	if ! curl -fsSL --connect-timeout 10 -o "$tmp" "https://github.com/$REPO/releases/download/$tag/$asset"; then
		echo "error: failed to download $asset for $tag" >&2
		exit 1
	fi
	chmod +x "$tmp"
	mv "$tmp" "$PREFIX/pi"
	trap - EXIT
	log "Installed binary to $PREFIX/pi"
	printf '%s\n' "$PREFIX/pi" > "$MANIFEST"
}

# --- Completions ---------------------------------------------------------------
#
# Generated from the live command metadata via the installed launcher itself
# (`pi completions <shell>`), never hardcoded.

install_completions() {
	pi_bin="$PREFIX/pi"
	if [ ! -x "$pi_bin" ]; then
		return 0
	fi
	home_dir="${HOME:?}"
	bash_dir="$home_dir/.bash_completion.d"
	zsh_dir="$home_dir/.zsh/completions"
	fish_dir="${XDG_CONFIG_HOME:-$home_dir/.config}/fish/completions"
	mkdir -p "$bash_dir" "$zsh_dir" "$fish_dir"
	if completion_out=$("$pi_bin" completions bash 2>/dev/null) && [ -n "$completion_out" ]; then
		printf '%s\n' "$completion_out" > "$bash_dir/pi"
		printf '%s\n' "$bash_dir/pi" >> "$MANIFEST"
	fi
	if completion_out=$("$pi_bin" completions zsh 2>/dev/null) && [ -n "$completion_out" ]; then
		printf '%s\n' "$completion_out" > "$zsh_dir/_pi"
		printf '%s\n' "$zsh_dir/_pi" >> "$MANIFEST"
	fi
	if completion_out=$("$pi_bin" completions fish 2>/dev/null) && [ -n "$completion_out" ]; then
		printf '%s\n' "$completion_out" > "$fish_dir/pi.fish"
		printf '%s\n' "$fish_dir/pi.fish" >> "$MANIFEST"
	fi
	log "Installed shell completions (bash, zsh, fish)"
}

# --- Main ------------------------------------------------------------------------

if [ "$UNINSTALL" -eq 1 ]; then
	uninstall
	exit 0
fi

if [ -z "$MODE" ]; then
	if [ -f "$ROOT_DIR/packages/coding-agent/package.json" ]; then
		MODE="source"
	else
		MODE="binary"
	fi
	# An explicit --ref implies a source install from that ref.
	if [ -n "$REF" ] && [ "$MODE" = "binary" ] && [ -f "$ROOT_DIR/packages/coding-agent/package.json" ]; then
		MODE="source"
	fi
fi

case "$MODE" in
	source) install_source ;;
	binary) install_binary ;;
	*) echo "error: unknown mode $MODE" >&2; exit 1 ;;
esac

install_completions

# A05: the install is not done until the installed launcher reports its real
# version output. Placeholders are not accepted.
if version_output=$("$PREFIX/pi" --version 2>&1); then
	log ""
	log "Installed: pi $version_output"
else
	echo "error: installed pi launcher failed --version:" >&2
	echo "$version_output" >&2
	exit 1
fi
log "Run 'pi' to get started."
