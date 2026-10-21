#!/usr/bin/env bash
# Saqme To Do - setup for Linux and macOS (on Windows use setup.cmd). Safe to run again: it updates the
# app and keeps your lists, settings and keys. Once installed, the app updates itself (Settings > Updates).
#
#   setup.sh                  install or update the app. No account needed: your lists stay on this computer.
#   setup.sh --cloud          also sync through your own free Cloudflare account (adds or updates it)
#   setup.sh --cloud-only     only the Cloudflare part (what WSL does by default, for the Windows app)
#   setup.sh --uninstall      remove the app (your lists stay; add --purge-data to delete them too)
#
#   --data DIR      keep the lists somewhere else (default: ~/.local/share/saqme, or on macOS
#                   ~/Library/Application Support/Saqme To Do)
#   --port N        local port of the app window (default 47613)
#   --no-start      do not start the app now        --no-autostart   do not start it at login
#   --app           on WSL: install the Linux app as well
#   --rotate-token  new access key: the old one stops working (implies --cloud; pair your devices again)
#   --device-login, --worker-name NAME, --yes    passed to the Cloudflare setup (--device-login implies --cloud)
#
# From the web:  curl -fsSL https://raw.githubusercontent.com/francuza9/saqme-to-do/main/scripts/setup.sh | bash
#                (add options after: ... | bash -s -- --cloud)
set -euo pipefail

# Everything runs from main, called on the last line: a download cut short never runs half a script.
main() {

REPO="${SAQME_REPO:-francuza9/saqme-to-do}"
BRANCH="${SAQME_BRANCH:-main}"
NODE_MAJOR=24          # downloaded when no Node.js 22.13+ is installed
NODE_MIN="22.13.0"     # node:sqlite without flags

mode="app"; cloud=0; purge=0; start=1; autostart=1; force_app=0
data=""; port=""; cloud_args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --cloud) cloud=1 ;;
    --cloud-only) mode="cloud-only"; cloud=1 ;;
    --uninstall) mode="uninstall" ;;
    --purge-data) purge=1 ;;
    --data) data="$2"; shift ;;
    --port) port="$2"; shift ;;
    --no-start) start=0 ;;
    --no-autostart) autostart=0 ;;
    --app) force_app=1 ;;
    --rotate-token|--device-login) cloud=1; cloud_args+=("$1") ;;
    --yes|-y) cloud_args+=("$1") ;;
    --worker-name) cloud_args+=(--worker-name "$2"); shift ;;
    -h|--help) sed -n '2,19p' "${BASH_SOURCE[0]:-$0}" 2>/dev/null | sed 's/^# \{0,1\}//' || echo "See docs/setup.md"; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)"; exit 2 ;;
  esac
  shift
done

# ---------------------------------------------------------------- output
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; M=$'\033[35;1m'; N=$'\033[0m'; else B=""; G=""; Y=""; R=""; M=""; N=""; fi
step() { printf '\n%s== %s%s\n' "$M" "$1" "$N"; }
ok()   { printf '   %sok%s  %s\n' "$G" "$N" "$1"; }
info() { printf '       %s\n' "$1"; }
warn() { printf '   %s!!%s  %s\n' "$Y" "$N" "$1"; }
die()  { printf '\n%sSetup stopped:%s %s\n' "$R" "$N" "$1"; [ -n "${2:-}" ] && printf 'What to do: %s\n' "$2"; printf 'Running setup again is safe - finished steps are skipped.\n'; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }
# download $1 to $2; resumes after a dropped connection instead of starting over (large files, flaky networks).
# https addresses stay https (no redirect to plain http); file:// is for tests
fetch() {
  local attempt https=()
  rm -f "$2"
  case "$1" in https://*) if has curl; then https=(--proto '=https' --tlsv1.2); else https=(--https-only); fi ;; esac
  for attempt in 1 2 3 4 5; do
    if has curl; then curl -fsSL "${https[@]+"${https[@]}"}" --retry 2 --retry-delay 2 -C - "$1" -o "$2" && return 0
    elif has wget; then wget -q "${https[@]+"${https[@]}"}" -c --tries=2 -O "$2" "$1" && return 0
    else return 1; fi
    sleep 2
  done
  return 1
}
# a small file that may not be there: 0 = downloaded, 1 = not there (404), 2 = no answer
fetch_maybe() {
  local code rc=0 https=()
  rm -f "$2"
  if has curl; then
    case "$1" in https://*) https=(--proto '=https' --tlsv1.2) ;; esac
    code="$(curl -sSL "${https[@]+"${https[@]}"}" --retry 2 -o "$2" -w '%{http_code}' "$1" 2>/dev/null)" || rc=$?
    case "$1" in file://*) [ "$rc" = 0 ] && return 0; [ "$rc" = 37 ] && return 1; return 2 ;; esac
    [ "$rc" = 0 ] && [ "$code" = 200 ] && return 0
    [ "$code" = 404 ] && return 1
    return 2
  fi
  wget -q -O "$2" "$1" || rc=$?
  [ "$rc" = 0 ] && return 0
  [ "$rc" = 8 ] && return 1   # (the server said no: there is no such file)
  return 2
}
src_tmp=""; node_tmp=""
trap 'rm -rf "$src_tmp" "$node_tmp"' EXIT
# an app this setup stopped always comes back, also when setup stops halfway (restore_app, below)
was_running=0; restarted=0

# ---------------------------------------------------------------- platform and paths
os="$(uname -s)"
case "$os" in
  Linux) platform=linux ;;
  Darwin) platform=mac ;;
  *) die "this script is for Linux and macOS." "On Windows, run setup.cmd (see README.md)." ;;
esac
wsl=0
# (not /proc/version: containers on a WSL2 kernel say "microsoft" there too)
if [ "$platform" = linux ] && { [ -n "${WSL_DISTRO_NAME:-}${WSL_INTEROP:-}" ] || has wslpath; }; then wsl=1; fi
if [ "$wsl" = 1 ] && [ "$mode" = app ] && [ "$force_app" = 0 ]; then
  mode="cloud-only"; cloud=1
  info "WSL: setting up the cloud part for the Windows app (install the app itself with setup.cmd on Windows)."
  info "To install the Linux app inside WSL as well, run with --app."
fi

# The install (local/update.mjs keeps it; one folder per version, so an update never runs half old, half new):
#   $APP_DIR/versions/<X.Y.Z>/   the app (local/, worker/, scripts/)      $APP_DIR/current, previous   which one runs
#   $APP_DIR/cloud/              where the Worker is deployed from        $APP_DIR/node/   Node.js, if downloaded
#   $APP_DIR/update/             what the updater downloads and says      $APP_DIR/icon-512.png   for menus
if [ "$platform" = mac ]; then
  DEFAULT_DATA="$HOME/Library/Application Support/Saqme To Do"
  APP_DIR="$HOME/Library/Application Support/Saqme To Do/app"
  CONFIG_DIR="$HOME/Library/Application Support/Saqme To Do/setup"
else
  DEFAULT_DATA="${XDG_DATA_HOME:-$HOME/.local/share}/saqme"
  APP_DIR="$HOME/.local/lib/saqme"
  CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/saqme"
fi
BIN_DIR="$HOME/.local/bin"
BIN="$BIN_DIR/saqme"
# the data folder: --data, $SAQME_DATA, else the one the installed app uses (an earlier --data), else the default
installed_data() { [ -f "$BIN" ] && sed -n 's/^export SAQME_DATA="\(.*\)"$/\1/p' "$BIN" | head -n 1 || true; }
absolute() {   # an absolute path without "." / ".." / symlink parts (the folder may not exist yet)
  local p="$1"
  case "$p" in /*) ;; *) p="$PWD/$p" ;; esac
  if [ -d "$p" ]; then (cd "$p" && pwd -P)
  elif [ -d "$(dirname "$p")" ]; then printf '%s/%s\n' "$(cd "$(dirname "$p")" && pwd -P)" "$(basename "$p")"
  else printf '%s\n' "${p%/}"; fi
}
data="${data:-${SAQME_DATA:-$(installed_data)}}"
DATA_DIR="$(absolute "${data:-$DEFAULT_DATA}")"
DEFAULT_DATA="$(absolute "$DEFAULT_DATA")"
[ -n "$data" ] && [ "$DATA_DIR" = "$DEFAULT_DATA" ] && data=""
DESKTOP_FILE="${XDG_DATA_HOME:-$HOME/.local/share}/applications/saqme-todo.desktop"
INVITE_DESKTOP_FILE="${XDG_DATA_HOME:-$HOME/.local/share}/applications/saqme-todo-invite.desktop"
AUTOSTART_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/autostart/saqme-todo.desktop"
UNIT_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/saqme-todo.service"
MAC_APP="$HOME/Applications/Saqme To Do.app"
MAC_INVITE_APP="$HOME/Applications/Saqme To Do Invites.app"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
AGENT_ID="com.saqme.todo"
AGENT_FILE="$HOME/Library/LaunchAgents/$AGENT_ID.plist"

# ---------------------------------------------------------------- running app
app_running() { [ -x "$BIN" ] && "$BIN" status 2>/dev/null | grep -q '^Running'; }
stop_app() {
  if app_running; then was_running=1; fi
  if [ -x "$BIN" ]; then "$BIN" stop >/dev/null 2>&1 || true; fi
  if [ "$platform" = mac ]; then launchctl bootout "gui/$(id -u)/$AGENT_ID" >/dev/null 2>&1 || true
  elif has systemctl; then systemctl --user stop saqme-todo.service >/dev/null 2>&1 || true; fi
  sleep 0.5
}
# (on exit) the app this setup stopped and did not start again: started, the way it ran
restore_app() {
  [ "$was_running" = 1 ] && [ "$restarted" = 0 ] && [ "$mode" != uninstall ] && [ -x "$BIN" ] || return 0
  app_running && return 0
  if [ "$platform" = mac ] && [ -f "$AGENT_FILE" ]; then launchctl bootstrap "gui/$(id -u)" "$AGENT_FILE" >/dev/null 2>&1 || true
  elif [ -f "$UNIT_FILE" ] && has systemctl; then systemctl --user start saqme-todo.service >/dev/null 2>&1 || true
  else nohup "$BIN" serve >/dev/null 2>&1 & fi
  printf '       (the app was started again)\n'
}
# started at the end: unless --no-start, and always when it ran before
want_start() { [ "$start" = 1 ] || [ "$was_running" = 1 ]; }
trap 'restore_app; rm -rf "$src_tmp" "$node_tmp"' EXIT

# ---------------------------------------------------------------- uninstall
# Deletes what Saqme created in the data folder and nothing else: --data may point at a folder with other
# files in it (a synced folder, Documents). Never the home folder or a folder above it.
purge_data() {
  local home
  home="$(cd "$HOME" && pwd -P)"
  if [ "$DATA_DIR" = / ]; then die "refusing to delete /." "Check --data / SAQME_DATA."; fi
  case "$home/" in "$DATA_DIR"/*) die "refusing to purge $DATA_DIR: it holds your home folder." "Delete the lists by hand if you meant to." ;; esac
  if [ ! -d "$DATA_DIR" ]; then ok "no data folder at $DATA_DIR"; return; fi
  if [ "$DATA_DIR" != "$DEFAULT_DATA" ] && [ ! -f "$DATA_DIR/.saqme-data" ]; then
    die "$DATA_DIR was not set up by Saqme (no .saqme-data marker), so it was left alone." "Check --data; delete the lists there by hand if they are yours."
  fi
  rm -rf "$DATA_DIR/lists" "$DATA_DIR/local" "$DATA_DIR/sync" "$DATA_DIR/.saqme-data" "$CONFIG_DIR"
  rmdir "$DATA_DIR" 2>/dev/null || true
  ok "lists, settings and sync keys deleted ($DATA_DIR$([ -d "$DATA_DIR" ] && echo ', other files in it were kept'))"
}

if [ "$mode" = uninstall ]; then
  step "Removing Saqme To Do"
  stop_app
  if [ "$platform" = mac ]; then
    [ -d "$MAC_INVITE_APP" ] && [ -x "$LSREGISTER" ] && "$LSREGISTER" -u "$MAC_INVITE_APP" >/dev/null 2>&1 || true
    rm -f "$AGENT_FILE"; rm -rf "$MAC_APP" "$MAC_INVITE_APP"
  else
    if [ -f "$UNIT_FILE" ] && has systemctl; then systemctl --user disable saqme-todo.service >/dev/null 2>&1 || true; fi
    rm -f "$UNIT_FILE" "$AUTOSTART_FILE" "$DESKTOP_FILE" "$INVITE_DESKTOP_FILE"
    has systemctl && systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
  rm -f "$BIN"
  rm -rf "$APP_DIR" "$CONFIG_DIR/source"
  ok "app removed"
  if [ "$purge" = 1 ]; then
    purge_data
  else
    info "Your lists are still in $DATA_DIR/lists (add --purge-data to delete them)."
    [ -f "$CONFIG_DIR/cloud.json" ] && info "Your sync keys stay in $CONFIG_DIR/cloud.json (--purge-data deletes them too)."
  fi
  info "Cloud sync, if you set it up, stays in your Cloudflare account; docs/setup.md explains how to delete it."
  exit 0
fi

# ---------------------------------------------------------------- Node.js (first: it also checks and unpacks the download)
version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -t. -k1,1n -k2,2n -k3,3n | head -n 1)" = "$2" ]; }
NODE=""
find_node() {
  for cand in "$APP_DIR/node/bin/node" "$(command -v node 2>/dev/null || true)"; do
    [ -n "$cand" ] && [ -x "$cand" ] || continue
    v="$("$cand" -p 'process.versions.node' 2>/dev/null || true)"
    if [ -n "$v" ] && version_ge "$v" "$NODE_MIN"; then NODE="$cand"; return 0; fi
  done
  return 1
}

download_node() {
  local arch os_name libc ver file base sum got
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) die "there is no Node.js download for this processor ($(uname -m))." "Install Node.js $NODE_MIN or newer with your package manager and run setup again." ;;
  esac
  if [ "$platform" = mac ]; then
    os_name=darwin
    macver="$(sw_vers -productVersion 2>/dev/null || echo 0)"
    if ! version_ge "$macver.0.0" "13.5.0"; then
      die "the Node.js $NODE_MAJOR download needs macOS 13.5 or newer (this Mac has $macver)." "Install Node.js 22 (supports macOS 11 and newer) from https://nodejs.org or with Homebrew (brew install node@22), then run setup again."
    fi
  else
    os_name=linux
    libc="$( (ldd --version 2>&1 || true) | head -n 1)"
    if printf '%s' "$libc" | grep -qi musl; then
      die "this system uses musl (e.g. Alpine); the official Node.js builds need glibc." "Install Node.js $NODE_MIN or newer from your package manager (apk add nodejs npm) and run setup again."
    fi
    glibc="$(printf '%s' "$libc" | grep -oE '[0-9]+\.[0-9]+' | tail -n 1)"
    if [ -n "$glibc" ] && ! version_ge "$glibc.0" "2.28.0"; then
      die "this system's C library (glibc $glibc) is older than Node.js needs (2.28)." "Install Node.js $NODE_MIN or newer another way (your distribution, nvm, or an unofficial glibc-2.17 build) and run setup again."
    fi
  fi
  has curl || has wget || die "neither curl nor wget is installed." "Install curl (e.g. sudo apt install curl) and run this again."
  node_tmp="$(mktemp -d)"
  info "downloading Node.js $NODE_MAJOR for $os_name-$arch (about 50 MB, used only by Saqme)..."
  fetch "https://nodejs.org/dist/latest-v$NODE_MAJOR.x/SHASUMS256.txt" "$node_tmp/SHASUMS256.txt" || die "could not reach nodejs.org." "Check the internet connection, or install Node.js $NODE_MIN+ yourself."
  file="$(grep -oE "node-v[0-9.]+-$os_name-$arch\.tar\.gz" "$node_tmp/SHASUMS256.txt" | head -n 1)"
  [ -n "$file" ] || die "no Node.js $NODE_MAJOR build for $os_name-$arch." "Install Node.js $NODE_MIN+ yourself."
  sum="$(grep " $file\$" "$node_tmp/SHASUMS256.txt" | cut -d' ' -f1)"
  [ -n "$sum" ] || die "nodejs.org lists no checksum for $file." "Run setup again (or install Node.js $NODE_MIN+ yourself)."
  # from that version's own folder: "latest" may move on between the two downloads
  ver="${file#node-}"; ver="${ver%%-*}"
  base="https://nodejs.org/dist/$ver"
  fetch "$base/$file" "$node_tmp/$file" || die "could not download $file from nodejs.org." "Check the internet connection and run setup again (or install Node.js $NODE_MIN+ yourself)."
  if has sha256sum; then got="$(sha256sum "$node_tmp/$file" | cut -d' ' -f1)"; else got="$(shasum -a 256 "$node_tmp/$file" | cut -d' ' -f1)"; fi
  [ "$sum" = "$got" ] || die "the Node.js download is damaged (checksum mismatch)." "Run setup again."
  mkdir -p "$APP_DIR"
  rm -rf "$APP_DIR/node" && mkdir -p "$APP_DIR/node"
  tar -xzf "$node_tmp/$file" -C "$APP_DIR/node" --strip-components 1
  NODE="$APP_DIR/node/bin/node"
  "$NODE" -e 'require("node:sqlite")' 2>/dev/null || die "the downloaded Node.js does not run on this system." "Install Node.js $NODE_MIN+ with your package manager and run setup again."
  ok "Node.js $("$NODE" -p 'process.versions.node') ($NODE)"
  info "(downloaded just for Saqme; removed again by --uninstall)"
}

step "Checking tools"
if find_node; then ok "Node.js $("$NODE" -p 'process.versions.node') ($NODE)"; else download_node; fi
NODE_BIN_DIR="$(dirname "$NODE")"

# ---------------------------------------------------------------- source files
# A release's manifest (saqme-release.json, scripts/build-release.mjs) -> its version, or nothing when it is not one
release_version() {
  "$NODE" -e '
const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")), v = String(m.version || ""), a = m.asset || {};
if (m.schema !== 1 || !/^\d+\.\d+\.\d+$/.test(v) || m.tag !== "v" + v || a.name !== "saqme-" + v + ".zip" || !/^[0-9a-fA-F]{64}$/.test(a.sha256 || "") || !(a.size > 0)) process.exit(1);
console.log(v);' "$1" 2>/dev/null
}
# Checks a release's zip against its manifest (size and SHA-256), then unpacks it: manifest zip folder.
# Exit 3: it does not match; 4: not a zip this can unpack.
unpack_release() {
  "$NODE" -e '
const fs = require("fs"), path = require("path"), zlib = require("zlib"), crypto = require("crypto");
const [mf, zip, dest] = process.argv.slice(1);
const m = JSON.parse(fs.readFileSync(mf, "utf8")), b = fs.readFileSync(zip);
if (b.length !== m.asset.size || crypto.createHash("sha256").update(b).digest("hex") !== m.asset.sha256.toLowerCase()) process.exit(3);
let e = b.length - 22;
while (e >= 0 && b.readUInt32LE(e) !== 0x06054b50) e--;
if (e < 0) process.exit(4);
let p = b.readUInt32LE(e + 16);
for (let i = b.readUInt16LE(e + 10); i > 0; i--) {
  const method = b.readUInt16LE(p + 10), size = b.readUInt32LE(p + 20), off = b.readUInt32LE(p + 42), n = b.readUInt16LE(p + 28);
  const name = b.toString("utf8", p + 46, p + 46 + n);
  p += 46 + n + b.readUInt16LE(p + 30) + b.readUInt16LE(p + 32);
  if (path.isAbsolute(name) || name.split(/[\\/]/).includes("..") || (method !== 0 && method !== 8)) process.exit(4);
  const out = path.join(dest, name);
  if (name.endsWith("/")) { fs.mkdirSync(out, { recursive: true }); continue; }
  const at = off + 30 + b.readUInt16LE(off + 26) + b.readUInt16LE(off + 28), raw = b.subarray(at, at + size);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, method === 8 ? zlib.inflateRawSync(raw) : raw);
}' "$1" "$2" "$3"
}

step "Getting Saqme To Do"
# the repository this script is part of, when it runs from a file (a clone or an extracted release); piped from
# the web (curl ... | bash) there is no such file, and the current folder must not be mistaken for one
here=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; fi
if [ -n "$here" ] && [ -f "$here/../local/saqme.mjs" ]; then
  SRC="$(cd "$here/.." && pwd)"
  ok "using the files in $SRC"
else
  # run from the web: the newest release, checked against its manifest; the main branch only while there is none
  # (SAQME_SOURCE_URL: a source archive instead, for tests and forks; SAQME_RELEASES: where releases are, tests)
  has curl || has wget || die "neither curl nor wget is installed." "Install curl (e.g. sudo apt install curl) and run this again."
  src_tmp="$(mktemp -d)"
  releases="${SAQME_RELEASES:-https://github.com/$REPO/releases}"
  got=1
  if [ -z "${SAQME_SOURCE_URL:-}" ]; then fetch_maybe "$releases/latest/download/saqme-release.json" "$src_tmp/saqme-release.json" && got=0 || got=$?; fi
  case "$got" in
    0)
      v="$(release_version "$src_tmp/saqme-release.json")" || die "the release on GitHub has no valid manifest." "Try again later, or clone the repository and run scripts/setup.sh from it."
      info "downloading Saqme To Do $v"
      fetch "$releases/download/v$v/saqme-$v.zip" "$src_tmp/saqme-$v.zip" || die "could not download Saqme To Do $v." "Check the internet connection and run setup again."
      rc=0; unpack_release "$src_tmp/saqme-release.json" "$src_tmp/saqme-$v.zip" "$src_tmp/x" || rc=$?
      [ "$rc" = 3 ] && die "the download does not match the checksum of the release." "Run setup again; if it keeps happening, please open an issue on GitHub."
      [ "$rc" = 0 ] || die "the download could not be unpacked." "Run setup again; if it keeps happening, please open an issue on GitHub."
      inner="$src_tmp/x/saqme-$v"
      ;;
    1)
      url="${SAQME_SOURCE_URL:-https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH}"
      info "downloading $url$([ -z "${SAQME_SOURCE_URL:-}" ] && echo ' (no release published yet)')"
      fetch "$url" "$src_tmp/src.tar.gz" || die "could not download Saqme To Do." "Check the internet connection, or clone the repository and run scripts/setup.sh from it."
      mkdir -p "$src_tmp/x" && tar -xzf "$src_tmp/src.tar.gz" -C "$src_tmp/x"
      inner="$(find "$src_tmp/x" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
      ;;
    *) die "could not reach GitHub." "Check the internet connection, or clone the repository and run scripts/setup.sh from it." ;;
  esac
  { [ -n "$inner" ] && [ -f "$inner/local/saqme.mjs" ] && [ -f "$inner/scripts/setup.sh" ]; } || die "the download is not Saqme To Do." "Run setup again; if it keeps failing, clone the repository and run scripts/setup.sh from it."
  SRC="$inner"
  ok "downloaded"
fi

# wrangler of an install before 1.1.0 (in the app folder, or in the source setup downloaded): moved to the Worker's
# deploy folder instead of downloaded again
adopt_wrangler() {
  local ws="$APP_DIR/cloud/worker" old
  [ -d "$ws/node_modules" ] && return 0
  for old in "$APP_DIR/worker/node_modules" "$CONFIG_DIR/source/worker/node_modules"; do
    if [ -d "$old" ]; then mkdir -p "$ws" && mv "$old" "$ws/node_modules" && return 0; fi
  done
  return 0
}

# ---------------------------------------------------------------- the app
# saqme://join links (the invite page of a list someone shares) open the app on macOS, which asks before joining.
# A shell-script app cannot receive a link there (it comes as an Apple event), so a small AppleScript applet takes
# it and hands it to `saqme invite`. Registered with Launch Services; --uninstall removes it.
install_mac_invite_handler() {
  if ! has osacompile || [ ! -x /usr/libexec/PlistBuddy ]; then warn "saqme:// invite links: osacompile is missing, so paste invites instead (Settings > Sync > Join a shared list)"; return; fi
  local src plist pb bin_as
  src="$(mktemp -d)/invite.applescript"
  bin_as="$(printf '%s' "$BIN" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  cat > "$src" <<EOF
on open location theURL
  do shell script quoted form of "$bin_as" & " invite " & quoted form of theURL & " >/dev/null 2>&1 &"
end open location
on run
  do shell script quoted form of "$bin_as" & " open >/dev/null 2>&1 &"
end run
EOF
  rm -rf "$MAC_INVITE_APP"
  if ! osacompile -o "$MAC_INVITE_APP" "$src" >/dev/null 2>&1; then warn "saqme:// invite links: the handler could not be built; paste invites instead (Settings > Sync > Join a shared list)"; return; fi
  plist="$MAC_INVITE_APP/Contents/Info.plist"
  pb=/usr/libexec/PlistBuddy
  "$pb" -c "Set :CFBundleIdentifier $AGENT_ID.invite" "$plist" >/dev/null 2>&1 || "$pb" -c "Add :CFBundleIdentifier string $AGENT_ID.invite" "$plist" >/dev/null 2>&1 || true
  "$pb" -c "Delete :LSUIElement" "$plist" >/dev/null 2>&1 || true
  "$pb" -c "Add :LSUIElement bool true" "$plist" >/dev/null 2>&1 || true
  "$pb" -c "Delete :CFBundleURLTypes" "$plist" >/dev/null 2>&1 || true
  "$pb" -c "Add :CFBundleURLTypes array" -c "Add :CFBundleURLTypes:0 dict" -c "Add :CFBundleURLTypes:0:CFBundleURLName string Saqme invite link" \
    -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string saqme" "$plist" >/dev/null 2>&1 || true
  cp "$MAC_APP/Contents/Resources/AppIcon.icns" "$MAC_INVITE_APP/Contents/Resources/applet.icns" 2>/dev/null || true
  # (the plist changed after osacompile signed the applet: sign it again, ad hoc, or macOS may call it damaged)
  has codesign && codesign --force --sign - "$MAC_INVITE_APP" >/dev/null 2>&1 || true
  [ -x "$LSREGISTER" ] && "$LSREGISTER" -f "$MAC_INVITE_APP" >/dev/null 2>&1 || true
  ok "saqme:// invite links open Saqme To Do ($MAC_INVITE_APP)"
}

install_app() {
  step "Installing the app"
  mkdir -p "$APP_DIR" "$BIN_DIR" "$DATA_DIR/lists"
  # marks the folder as Saqme's: --purge-data deletes only what Saqme created, and only where this is
  [ -f "$DATA_DIR/.saqme-data" ] || printf 'Saqme To Do keeps its lists here (lists/, local/, sync/).\n' > "$DATA_DIR/.saqme-data"
  # the version folder, next to the one that runs (which keeps running); $v is worker/package.json's version
  local v vdir t
  v="$("$NODE" "$SRC/local/update.mjs" stage --source "$SRC" --root "$APP_DIR")" || die "the app files could not be copied to $APP_DIR/versions." "Check that the disk is not full, then run setup again."
  vdir="$APP_DIR/versions/$v"
  # sanity check before anything points at it: a copy of the app starts on a scratch folder and syncs a list
  t="$("$NODE" --disable-warning=ExperimentalWarning "$vdir/local/saqme.mjs" selftest 2>&1 || true)"
  if ! printf '%s' "$t" | grep -q 'SELFTEST OK'; then
    [ "$(cat "$APP_DIR/current" 2>/dev/null || true)" = "$v" ] || rm -rf "$vdir"
    printf '%s\n' "$t" | tail -n 20
    die "version $v failed its self-check, so it was not installed." "Please open an issue on GitHub with the output above."
  fi
  ok "version $v in $vdir (self-check passed)"

  stop_app
  "$NODE" "$SRC/local/update.mjs" switch --root "$APP_DIR" --version "$v" >/dev/null || die "could not switch to version $v." "Run setup again."
  local data_env=""
  if [ -n "$data" ]; then data_env="export SAQME_DATA=\"$DATA_DIR\""; fi
  cat > "$BIN" <<EOF
#!/bin/sh
# Saqme To Do launcher (written by setup.sh): saqme open | serve | status | stop | update | version | pair-phone
# Runs the version $APP_DIR/current names (the updater switches it; previous is the one before it).
$data_env
export SAQME_LAUNCHER="$BIN"
root="$APP_DIR"
v="\$(cat "\$root/current" 2>/dev/null)"
[ -n "\$v" ] && [ -f "\$root/versions/\$v/local/saqme.mjs" ] || v="\$(cat "\$root/previous" 2>/dev/null)"
exec "$NODE" --disable-warning=ExperimentalWarning "\$root/versions/\$v/local/saqme.mjs" "\$@"
EOF
  chmod 755 "$BIN"
  ok "command: $BIN"
  case ":$PATH:" in *":$BIN_DIR:"*) ;; *) info "($BIN_DIR is not on your PATH: run it as $BIN, or add that folder to PATH)" ;; esac
  # an install before 1.1.0 kept the app in $APP_DIR itself (and setup's download in $CONFIG_DIR/source)
  adopt_wrangler
  rm -rf "$APP_DIR/local" "$APP_DIR/scripts" "$APP_DIR/worker" "$APP_DIR/LICENSE"
  case "$SRC/" in "$CONFIG_DIR/source/"*) ;; *) rm -rf "$CONFIG_DIR/source" ;; esac
  # what menus and the Dock show: stays where it is when the version changes
  cp "$vdir/worker/public/icons/icon-512.png" "$APP_DIR/icon-512.png"

  if [ -n "$port" ]; then
    mkdir -p "$DATA_DIR/local"
    printf '{"port": %s}\n' "$port" > "$DATA_DIR/local/settings.json"
    ok "port $port"
  fi

  if [ "$platform" = mac ]; then
    mkdir -p "$MAC_APP/Contents/MacOS" "$MAC_APP/Contents/Resources"
    cat > "$MAC_APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Saqme To Do</string>
  <key>CFBundleDisplayName</key><string>Saqme To Do</string>
  <key>CFBundleIdentifier</key><string>$AGENT_ID.launcher</string>
  <key>CFBundleExecutable</key><string>saqme-todo</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
</dict></plist>
EOF
    printf '#!/bin/sh\nexec "%s" open\n' "$BIN" > "$MAC_APP/Contents/MacOS/saqme-todo"
    chmod 755 "$MAC_APP/Contents/MacOS/saqme-todo"
    "$NODE" "$vdir/local/icns.mjs" "$APP_DIR/icon-512.png" "$MAC_APP/Contents/Resources/AppIcon.icns"
    ok "app: $MAC_APP (Launchpad, Spotlight)"
    install_mac_invite_handler
  else
    mkdir -p "$(dirname "$DESKTOP_FILE")"
    cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=Saqme To Do
Comment=To-do lists in plain markdown
Exec="$BIN" open
Icon=$APP_DIR/icon-512.png
Terminal=false
Categories=Office;ProjectManagement;
StartupNotify=false
EOF
    # saqme://join links (the invite page of a list someone shares) open the app, which asks before joining
    cat > "$INVITE_DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=Saqme To Do (invite links)
Exec="$BIN" invite %u
Icon=$APP_DIR/icon-512.png
Terminal=false
NoDisplay=true
MimeType=x-scheme-handler/saqme;
EOF
    has update-desktop-database && update-desktop-database "$(dirname "$DESKTOP_FILE")" >/dev/null 2>&1 || true
    has xdg-mime && xdg-mime default "$(basename "$INVITE_DESKTOP_FILE")" x-scheme-handler/saqme >/dev/null 2>&1 || true
    ok "menu entry: Saqme To Do (and saqme:// invite links)"
  fi
}

setup_autostart() {
  local serve_cmd="\"$BIN\" serve"
  if [ "$platform" = mac ]; then
    rm -f "$AGENT_FILE"
    [ "$autostart" = 1 ] || { info "not starting at login (--no-autostart)"; return; }
    mkdir -p "$(dirname "$AGENT_FILE")" "$DATA_DIR/local"
    cat > "$AGENT_FILE" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$AGENT_ID</string>
  <key>ProgramArguments</key><array><string>$BIN</string><string>serve</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>$DATA_DIR/local/launchd.log</string>
  <key>StandardErrorPath</key><string>$DATA_DIR/local/launchd.log</string>
</dict></plist>
EOF
    if want_start; then launchctl bootstrap "gui/$(id -u)" "$AGENT_FILE" >/dev/null 2>&1 || launchctl load -w "$AGENT_FILE" >/dev/null 2>&1 || true; restarted=1; fi
    ok "starts at login (LaunchAgent $AGENT_ID)"
    return
  fi
  rm -f "$AUTOSTART_FILE"
  if [ "$autostart" = 0 ]; then
    if [ -f "$UNIT_FILE" ] && has systemctl; then systemctl --user disable saqme-todo.service >/dev/null 2>&1 || true; rm -f "$UNIT_FILE"; fi
    info "not starting at login (--no-autostart)"; return
  fi
  if has systemctl && systemctl --user show-environment >/dev/null 2>&1; then
    mkdir -p "$(dirname "$UNIT_FILE")"
    cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Saqme To Do (lists folder, sync and reminders)

[Service]
ExecStart=$serve_cmd
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable saqme-todo.service >/dev/null 2>&1
    if want_start; then systemctl --user restart saqme-todo.service; restarted=1; fi
    ok "starts at login (systemd user service saqme-todo)"
  else
    mkdir -p "$(dirname "$AUTOSTART_FILE")"
    cat > "$AUTOSTART_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=Saqme To Do
Comment=Keeps the lists folder in sync and shows reminders
Exec=$serve_cmd
NoDisplay=true
X-GNOME-Autostart-enabled=true
EOF
    ok "starts at login (desktop autostart entry)"
  fi
}

start_app() {
  want_start || return 0
  if ! app_running; then
    nohup "$BIN" serve >/dev/null 2>&1 &
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do app_running && break; sleep 0.5; done
  fi
  restarted=1
  app_running || die "the app did not start." "See $DATA_DIR/local/saqme.log, then run setup again."
  ok "running"
  if [ "$start" = 1 ] && { [ "$platform" = mac ] || [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; }; then
    "$BIN" open >/dev/null 2>&1 && ok "window opened" || true
  fi
}

if [ "$mode" = app ]; then
  install_app
  setup_autostart
fi

# ---------------------------------------------------------------- cloud (optional)
if [ "$cloud" = 1 ]; then
  step "Cloud sync (your Cloudflare account)"
  desktop=""
  if [ "$mode" = app ]; then desktop="$DATA_DIR/sync/config.json"
  elif [ "$wsl" = 1 ] && has cmd.exe; then
    appdata_win="$(cmd.exe /c 'echo %APPDATA%' 2>/dev/null | tr -d '\r' || true)"
    if [ -n "$appdata_win" ]; then
      appdata="$(wslpath -u "$appdata_win" 2>/dev/null || true)"
      if [ -n "$appdata" ] && [ -d "$appdata/SaqmeToDo" ]; then
        desktop="$appdata/SaqmeToDo/sync/config.json"
        info "Found the Windows desktop app - it will be connected too."
      fi
    fi
  fi
  extra=()
  [ -n "$desktop" ] && extra+=(--desktop-config "$desktop")
  [ "$mode" = app ] && extra+=(--pair-again "$BIN pair-phone")
  # deployed from $APP_DIR/cloud (the app's updater deploys from there too; wrangler stays between runs)
  adopt_wrangler
  ws="$("$NODE" "$SRC/local/update.mjs" workspace --source "$SRC" --root "$APP_DIR")" || die "could not prepare $APP_DIR/cloud." "Check that the disk is not full, then run setup again."
  # the cloud tools (wrangler) come through npm, from the same Node.js
  PATH="$NODE_BIN_DIR:$PATH" "$NODE" "$ws/scripts/cloud-setup.mjs" --state "$CONFIG_DIR/cloud.json" \
    ${extra[@]+"${extra[@]}"} ${cloud_args[@]+"${cloud_args[@]}"} || exit 1
fi

if [ "$mode" = app ]; then
  step "Starting"
  start_app
  printf '\n%sSaqme To Do is ready.%s\n' "$B" "$N"
  info "Open it from your applications menu$([ "$platform" = mac ] && echo ' or Spotlight'), or run: $BIN open"
  info "Your lists are plain markdown files in: $DATA_DIR/lists"
  info "It updates itself (Settings > Updates); you never need to run this again for that."
  if [ "$cloud" = 0 ]; then
    if [ -f "$DATA_DIR/sync/config.json" ]; then info "Cloud sync stays on (set up earlier); the app keeps it updated."
    else info "Want them on your phone too? In the app: Settings > Sync > Set up sync (free Cloudflare account)."; fi
  fi
fi
}

main "$@"
