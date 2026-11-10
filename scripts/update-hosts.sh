#!/usr/bin/env bash
# Brings the Calli on the other machines up to what their clone's origin has: on each machine from
# hosts.json it fast-forwards the clone, builds a fresh snapshot directory, and — once every
# thread over there has finished, the way restart.sh waits here — switches the service onto it.
# Nothing is forced: a machine that cannot be reached, a clone that has diverged from its origin,
# or a build that fails is reported and skipped, and the daemon running there is left as it was.
# A daemon that answers again after the switch gets the previous snapshot put back.
#
#   scripts/update-hosts.sh              every machine in hosts.json
#   scripts/update-hosts.sh devbox       one machine, by its id
#   scripts/update-hosts.sh --check      fetch and say what each machine would get, change nothing
#
# The layout it expects over there is the one agents have been setting up by hand:
#   ~/code/calli                    a clone of the project; `git pull` runs here
#   ~/.local/share/calli-<sha>      a built snapshot without .git; the service runs from one
#   ~/.config/systemd/user/calli.service names the snapshot in its WorkingDirectory — often only
#   through a drop-in (calli.service.d/90-calli-release.conf) that outranks the unit's own line
# A machine whose hosts.json entry has "repo": "<path>" keeps its clone elsewhere; the service
# name may differ through CALLI_UPDATE_SERVICE. Code reaches the machines through their own
# origin: push the hub's branch there first, then run this.
set -euo pipefail

HUB_STATE="${XDG_STATE_HOME:-$HOME/.local/state}/calli"
HOSTS_FILE="${CALLI_HOSTS_FILE:-$HUB_STATE/data/hosts.json}"
SSH_BIN="${CALLI_SSH_BIN:-ssh}"
SERVICE="${CALLI_UPDATE_SERVICE:-calli}"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o ControlMaster=no -o ControlPath=none -T)
POLL=5
ONLY='' DRY=0

for arg in "$@"; do
  case "$arg" in
    --check) DRY=1 ;;
    -*) echo "Unknown option: $arg" >&2; exit 2 ;;
    *) ONLY="$arg" ;;
  esac
done

[ -f "$HOSTS_FILE" ] || { echo "No machines: $HOSTS_FILE not found." >&2; exit 1; }

# One line per machine: id, ssh target, the daemon's socket over there, the clone's path (default ~/code/calli).
mapfile -t MACHINES < <(node -e '
  const doc = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  for (const h of doc.hosts ?? []) {
    if (process.argv[2] && h.id !== process.argv[2]) continue;
    if (!h.id || !h.target) continue;
    console.log([h.id, h.target, h.socket ?? "~/.local/state/calli/daemon.sock", h.repo ?? "~/code/calli"].join("\t"));
  }
' "$HOSTS_FILE" "$ONLY")
[ "${#MACHINES[@]}" -gt 0 ] || { echo "No such machine${ONLY:+: $ONLY} in $HOSTS_FILE." >&2; exit 1; }

say() { echo "[$(date '+%H:%M:%S')] $*"; }

# What runs on the machine, read from stdin (`sh -s`): the five arguments arrive as $1..$5 over
# there, so the script itself needs no quoting of values. It ends with `fail …` when it gives up;
# the hub-side loop only looks for that one prefix.
update_over_there() { "$SSH_BIN" "${SSH_OPTS[@]}" "$1" sh -s -- "$2" "$3" "$4" "$5" "$6" <<'REMOTE'
set -u
service=$1 socket=$2 repo=$3 dry=$4 poll=$5
say() { echo "[$(date '+%H:%M:%S')] $*"; }
fail() { echo "fail $*"; exit 0; }
case "$repo" in '~'*) repo="$HOME/${repo#\~/}" ;; esac
case "$socket" in '~'*) socket="$HOME/${socket#\~/}" ;; esac

unit="$(systemctl --user show -p FragmentPath --value "$service" 2>/dev/null || true)"
[ -n "$unit" ] && [ -f "$unit" ] || fail "no $service user service on this machine"
workdir="$(systemctl --user show -p WorkingDirectory --value "$service")"
[ -d "$repo/.git" ] || fail "no clone at $repo (set \"repo\" in the hub's hosts.json)"
cd "$repo" || fail "cannot enter $repo"

git fetch --quiet origin 2>/dev/null || fail "git fetch from origin failed (offline?)"
upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || echo origin/main)"
if ! git merge-base --is-ancestor "$upstream" HEAD; then
  git merge --ff-only --quiet "$upstream" 2>/dev/null || fail "the clone has moved away from $upstream; it needs a person"
fi
new="$(git rev-parse --short HEAD)"

if [ "$(basename "$workdir")" = "calli-$new" ]; then
  echo "current: the service already runs calli-$new"
  exit 0
fi
if [ "$dry" = 1 ]; then
  echo "would update: ${workdir##*/} -> calli-$new"
  exit 0
fi

# A snapshot per version, so the previous one stays to fall back on. It lives next to the ones
# agents have been making by hand; the state home passed in is where the daemon keeps its data.
snap="$HOME/.local/share/calli-$new"
if [ ! -d "$snap" ]; then
  say "copying the tree into ${snap##*/}"
  mkdir -p "$snap"
  tar --exclude=./.git --exclude=./.worktrees --exclude=./shots -cf - . | tar -C "$snap" -xf -
fi
say "building ${snap##*/}"
if ! ( cd "$snap" && npm install --no-audit --no-fund >/dev/null 2>&1 && npm run build >/dev/null 2>&1 ); then
  rm -rf "$snap"
  fail "build failed; the running daemon was left alone"
fi
echo "$new" >"$snap/.calli-release"

# Its own turns end first, the way restart.sh waits for this hub's.
busy_seen=''
while :; do
  busy="$(curl -sf -m 5 --unix-socket "$socket" http://localhost/api/threads 2>/dev/null \
    | node -e 'let b="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(b).filter(t=>t.status==="running").length)}catch{console.log("?")}})' \
    || echo '?')"
  [ "$busy" = "0" ] && break
  [ "$busy" != "$busy_seen" ] && { say "waiting for $busy running thread(s) over there"; busy_seen="$busy"; }
  sleep "$poll"
done

# Which file pins the running release: the lexically last drop-in that sets WorkingDirectory — a
# drop-in outranks the unit file's own line, so editing the unit file alone switches nothing on a
# machine that pins releases this way — or the conventional 90-calli-release.conf when there is
# none yet. The unit file itself is never touched.
pin_dir="$HOME/.config/systemd/user/${service}.service.d"
pin="$(ls "$pin_dir"/*.conf 2>/dev/null | sort | while IFS= read -r f; do grep -q '^WorkingDirectory=' "$f" && printf '%s\n' "$f"; done | tail -n 1)"
[ -n "$pin" ] || pin="$pin_dir/90-calli-release.conf"
pin_write() { mkdir -p "$pin_dir"; printf '[Service]\nWorkingDirectory=%s\n' "$1" >"$pin"; }
put_back() {
  [ -n "$workdir" ] && pin_write "$workdir"
  systemctl --user daemon-reload
  systemctl --user restart "$service" 2>/dev/null || true
}

say "switching the service onto calli-$new"
mkdir -p "$pin_dir"
[ -f "$pin" ] && cp "$pin" "$pin.bak-$(date -u +%Y%m%dT%H%M%SZ)"
pin_write "$snap"
if ! systemctl --user daemon-reload || ! systemctl --user restart "$service"; then
  put_back
  fail "the switch failed; back on ${workdir##*/}"
fi
up=0
for _ in $(seq 1 30); do
  curl -sf -m 2 --unix-socket "$socket" http://localhost/api/health >/dev/null 2>&1 && { up=1; break; }
  sleep 1
done
if [ "$up" != 1 ]; then
  put_back
  fail "no answer after the switch; rolled back onto ${workdir##*/}"
fi
echo "done: the service runs calli-$new (was ${workdir##*/})"
REMOTE
}

FAILED=0
for line in "${MACHINES[@]}"; do
  IFS=$'\t' read -r id target socket repo <<<"$line"
  say "=== $id ($target)"
  # ssh exits non-zero on a timeout or a refused login: that machine is skipped, not the whole run.
  if out="$(update_over_there "$target" "$SERVICE" "$socket" "$repo" "$DRY" "$POLL" 2>&1)"; then
    echo "$out" | sed 's/^/  /'
  else
    status=$?
    echo "$out" | sed 's/^/  /'
    say "skipped: ssh to $target did not answer ($status)."
    FAILED=1
    continue
  fi
  grep -q '^fail ' <<<"$out" && FAILED=1
done
[ "$FAILED" = 0 ] || { say "Some machines were not updated."; exit 1; }
say "Every machine is up to what its origin has."
