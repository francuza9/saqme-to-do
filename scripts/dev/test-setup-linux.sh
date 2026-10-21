#!/usr/bin/env bash
# Tests scripts/setup.sh in throw-away Linux containers (needs Docker; downloads Node.js inside them):
# install -> app runs -> a hand-written list gets ids and reaches the API -> re-run keeps key and lists ->
# uninstall keeps lists -> --purge-data removes them, and only what Saqme created. Old and odd systems must
# stop with a clear message.
#   scripts/dev/test-setup-linux.sh [image ...]     (default: debian:10 ubuntu:20.04 fedora:41 centos:7)
#   an image name ending in +node gets the distribution's own Node.js first (e.g. alpine:3.22+node)
#   glibc older than 2.28 (centos:7 has 2.17, ubuntu:18.04 2.27) gets Node.js's unofficial glibc-2.17 build
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"

if [ "${1:-}" = --inside ]; then
  # ---- runs inside the container, as root, with the repository at /src (read-only)
  fails=0
  check() { if eval "$1"; then echo "  ok   $2"; else echo "  FAIL $2"; fails=$((fails + 1)); fi; }
  (ldd --version 2>&1 || true) | sed -n '1s/^/  glibc: /p'
  # first install as from the web (curl ... | bash): the script downloads the source itself (a local tarball here),
  # even from a folder whose parent looks like a Saqme checkout (anyone can create /tmp/local/saqme.mjs)
  (cd / && tar -czf /tmp/src.tar.gz --exclude=node_modules --exclude=.git --exclude=.wrangler src)
  mkdir -p /tmp/plant/local /tmp/plant/x && echo 'planted' > /tmp/plant/local/saqme.mjs
  (cd /tmp/plant/x && SAQME_SOURCE_URL=file:///tmp/src.tar.gz bash -s -- --no-autostart < /src/scripts/setup.sh) > /tmp/setup1.log 2>&1 || { cat /tmp/setup1.log; exit 1; }
  check 'grep -q "ok  downloaded" /tmp/setup1.log && ! grep -q /tmp/plant /tmp/setup1.log' 'piped install fetched the source (not the folder above)'
  tail -n 4 /tmp/setup1.log | sed 's/^/  | /'
  B="$HOME/.local/bin/saqme"
  A="$HOME/.local/lib/saqme"
  v="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' /src/worker/package.json | head -n 1)"
  check '[ -x "$B" ]' 'launcher installed'
  check '[ "$(cat "$A/current")" = "$v" ] && [ -f "$A/versions/$v/local/saqme.mjs" ] && [ ! -e "$A/local" ]' "version $v in its own folder, named by current"
  check '[ -f "$A/versions/$v/scripts/cloud-setup.mjs" ] && [ -f "$A/versions/$v/worker/package-lock.json" ]' 'the cloud setup is installed for Settings > Sync'
  check '"$B" version | grep -qx "$v"' 'saqme version'
  check '"$B" status | grep -q "^Running"' 'app is running'
  check '[ -f "$HOME/.local/share/applications/saqme-todo.desktop" ]' 'menu entry written'
  check '[ ! -e "$HOME/.config/autostart/saqme-todo.desktop" ]' 'no autostart with --no-autostart'
  lists="$HOME/.local/share/saqme/lists"
  printf '# Today\n- [ ] Water the plants\n  - [x] Buy soil\n' > "$lists/Home.md"
  for _ in $(seq 1 30); do grep -q '\^' "$lists/Home.md" && break; sleep 0.5; done
  check 'grep -qE "^- \[ \] Water the plants \^[0-9a-z]{8}$" "$lists/Home.md"' 'list file got ids'
  token="$(cat "$HOME/.local/share/saqme/local/token")"
  port="$(sed -E 's/.*"port":([0-9]+).*/\1/' "$HOME/.local/share/saqme/local/server.json")"
  body='{"deviceId":"test","cursor":0,"changes":[]}'
  got=""
  for _ in $(seq 1 30); do   # ids are written one cycle before the tasks are sent
    got="$(curl -s -H "authorization: Bearer $token" -H 'content-type: application/json' -d "$body" "http://127.0.0.1:$port/api/sync" | grep -oE '"text":\{"v":"[^"]*"' | sed -E 's/.*"v":"//; s/"$//' | sort | paste -sd'|' - || true)"
    [ -n "$got" ] && break; sleep 0.5
  done
  check '[ "$got" = "Buy soil|Water the plants" ]' "tasks reached the app ($got)"
  check '[ "$(curl -s -o /dev/null -w "%{http_code}" -H "Host: evil.example" "http://127.0.0.1:$port/")" = 403 ]' 'foreign host names refused'
  bash /src/scripts/setup.sh --no-autostart > /tmp/setup2.log 2>&1 || { cat /tmp/setup2.log; exit 1; }
  check '[ "$(cat "$HOME/.local/share/saqme/local/token")" = "$token" ]' 're-run keeps the key'
  check 'grep -q "Water the plants" "$lists/Home.md"' 're-run keeps the lists'
  node1="$(grep -m1 'ok  Node.js' /tmp/setup1.log)"; node2="$(grep -m1 'ok  Node.js' /tmp/setup2.log)"
  check '[ -n "$node1" ] && [ "${node1#*(}" = "${node2#*(}" ]' "re-run uses the same Node.js (${node1#*ok  })"
  # an update, as Settings > Updates installs it: a release of another version (worker/package.json), switched to
  # and restarted by the launcher; the lists stay (a version that does not start: worker/test/node/update.test.js)
  mkdir -p /tmp/rel && cp -R /src/local /src/scripts /tmp/rel/ && mkdir -p /tmp/rel/worker && cp -R /src/worker/src /src/worker/public /src/worker/migrations /src/worker/package-lock.json /src/worker/wrangler.toml.template /tmp/rel/worker/
  sed '0,/"version": *"[^"]*"/s//"version": "9.9.9"/' /src/worker/package.json > /tmp/rel/worker/package.json
  before="$(cat "$lists/Home.md")"
  node_bin="$(sed -n 's/^exec "\([^"]*\)".*/\1/p' "$B")"
  out="$("$node_bin" "$A/versions/$v/local/update.mjs" apply --source /tmp/rel --root "$A" --data "$HOME/.local/share/saqme" --port "$port" --restart spawn --launcher "$B" --no-worker 2>&1 || true)"
  check '[ "$(cat "$A/current")" = 9.9.9 ] && [ "$(cat "$A/previous")" = "$v" ] && "$B" status | grep -q "^Running"' "update to 9.9.9 applied and running ($out)"
  check '[ "$(cat "$lists/Home.md")" = "$before" ]' 'the update left the lists as they were'
  bash /src/scripts/setup.sh --uninstall > /tmp/setup3.log 2>&1
  check '[ ! -e "$B" ] && [ ! -d "$HOME/.local/lib/saqme" ]' 'uninstall removes the app'
  check '[ -f "$lists/Home.md" ]' 'uninstall keeps the lists'
  bash /src/scripts/setup.sh --uninstall --purge-data > /tmp/setup4.log 2>&1
  check '[ ! -d "$HOME/.local/share/saqme" ] && [ ! -d "$HOME/.config/saqme" ]' '--purge-data removes them (and the setup folder)'
  # --data inside a folder with other files: purge deletes only Saqme's part, and finds the folder by itself
  mkdir -p "$HOME/Sync" && echo keep > "$HOME/Sync/notes.txt"
  bash /src/scripts/setup.sh --no-autostart --no-start --data "$HOME/Sync" > /tmp/setup5.log 2>&1 || { cat /tmp/setup5.log; exit 1; }
  check '[ -f "$HOME/Sync/.saqme-data" ] && [ -d "$HOME/Sync/lists" ]' '--data folder set up and marked'
  bash /src/scripts/setup.sh --no-autostart --no-start > /tmp/setup6.log 2>&1 || { cat /tmp/setup6.log; exit 1; }
  check 'grep -q "SAQME_DATA=\"$HOME/Sync\"" "$B"' 're-run without --data keeps the folder chosen before'
  bash /src/scripts/setup.sh --uninstall --purge-data > /tmp/setup7.log 2>&1
  check '[ ! -e "$HOME/Sync/lists" ] && [ ! -e "$HOME/Sync/.saqme-data" ] && [ -f "$HOME/Sync/notes.txt" ]' '--purge-data deletes only what Saqme created there'
  # never the home folder or an unmarked folder
  mkdir -p "$HOME/Other/lists" && echo '- [ ] mine' > "$HOME/Other/lists/Mine.md"
  out="$(bash /src/scripts/setup.sh --uninstall --purge-data --data "$HOME" 2>&1 || true)"
  check 'echo "$out" | grep -q "refusing to purge" && [ -f "$HOME/Sync/notes.txt" ]' 'refuses to purge the home folder'
  out="$(bash /src/scripts/setup.sh --uninstall --purge-data --data "$HOME/Other" 2>&1 || true)"
  check 'echo "$out" | grep -q "no .saqme-data marker" && [ -f "$HOME/Other/lists/Mine.md" ]' 'leaves a folder Saqme did not set up alone'
  exit $fails
fi

if [ "${1:-}" = --inside-expect-fail ]; then
  # ---- systems setup cannot serve: it must stop early with a useful message, not half-install
  out="$(bash /src/scripts/setup.sh --no-autostart 2>&1 || true)"
  echo "$out" | grep -E 'Setup stopped|What to do' | sed 's/^/  | /'
  echo "$out" | grep -q 'What to do' && [ ! -e "$HOME/.local/bin/saqme" ] && { echo "  ok   stops with advice"; exit 0; }
  echo "$out" | tail -n 20; echo "  FAIL no clear stop"; exit 1
fi

images=("$@")
[ ${#images[@]} -gt 0 ] || images=(debian:10 ubuntu:20.04 fedora:41 centos:7)
total=0
for spec in "${images[@]}"; do
  echo "== $spec"
  img="${spec%+node}"
  case "$spec" in
    *+node) inner=--inside ;;
    alpine*) inner=--inside-expect-fail ;;
    *) inner=--inside ;;
  esac
  case "$img" in
    debian:10) prep='printf "deb http://archive.debian.org/debian buster main\n" > /etc/apt/sources.list; apt-get update -qq >/dev/null; apt-get install -y -qq curl ca-certificates >/dev/null' ;;
    debian*|ubuntu*) prep='apt-get update -qq >/dev/null; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates >/dev/null' ;;
    fedora*|rocky*|alma*) prep='dnf install -y -q curl tar gzip findutils >/dev/null 2>&1' ;;
    centos:7*) prep='true' ;;
    alpine*) prep='apk add -q bash curl'; [ "$spec" = "$img" ] || prep="$prep nodejs" ;;
    *) prep='true' ;;
  esac
  if docker run --rm -v "$repo:/src:ro" "$img" sh -c "$prep && bash /src/scripts/dev/test-setup-linux.sh $inner"; then echo "   passed"; else echo "   FAILED"; total=$((total + 1)); fi
done
[ "$total" = 0 ] && echo "setup checks passed on: ${images[*]}" || { echo "$total image(s) failed"; exit 1; }
