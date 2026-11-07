#!/bin/bash
# docker-entrypoint.sh — first-boot profile setup + `dsh web` launcher.
#
# The container starts as root. The entrypoint:
#   1. creates the data roots; when running as root it self-heals volume
#      ownership so either root or an optional non-root runtime user can write
#      everywhere (K8s / RainYun volumes do NOT inherit image ownership);
#   2. writes the loopback webserver patch (dsh 0.2.2+ rejects wildcard
#      binds, so the gate is the public listener);
#   3. runs every long-lived process as root by default, or drops to
#      DSH_RUNTIME_UID/DSH_RUNTIME_GID when those are set to a non-zero id.
#
# Gate mode (default on, env DSH_AUTH=1): dsh binds 127.0.0.1:3081 and the
# built-in gate (auth-proxy.js) binds 0.0.0.0:${PORT}, enforcing first-visit
# password registration + login. With DSH_AUTH=0 the gate still owns the
# public port but forwards without a password: dsh 0.2.2+ rejects wildcard
# binds, so it always stays on loopback and the gate is the only public
# listener in both modes.
set -euo pipefail

# Build marker: bump on every image publish so deployments can verify from the
# logs which build is actually running (RainYun caches images by tag).
DSH_DOCKER_BUILD="${DSH_DOCKER_BUILD:-2026-11-07-0.2.2-rc.1-1}"

# Root is the default runtime user. Set DSH_RUNTIME_UID/DSH_RUNTIME_GID to a
# non-zero id (e.g. 1000) to run dsh and the auth gate unprivileged instead.
RUNTIME_UID="${DSH_RUNTIME_UID:-0}"
RUNTIME_GID="${DSH_RUNTIME_GID:-0}"

export DSH_HOME="${DSH_HOME:-/data}"

# Sanitize PORT: must be a valid port number.
PORT="${PORT:-3080}"
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "[dsh-entrypoint] invalid PORT '$PORT', falling back to 3080" >&2
  PORT=3080
fi

AUTH_MODE="${DSH_AUTH:-1}"
DSH_INTERNAL_PORT="${DSH_INTERNAL_PORT:-3081}"

PROFILE_DIR="$DSH_HOME/profiles/web"
PROFILE_PATCH="$PROFILE_DIR/cordis.patch.yml"

# 1) Create the data roots, then own them so the runtime user can write
#    everywhere. Order matters: chowning BEFORE creating nested dirs would
#    leave the new dirs root-owned (EACCES on profiles/node_modules).
#    A fresh/root-owned volume (K8s / RainYun PVs do not inherit image
#    ownership) is chowned recursively once; otherwise only the roots and the
#    profiles subtree created here are owned, keeping restarts fast.
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$PROFILE_DIR" /workspace
  if [ "$RUNTIME_UID" != "0" ]; then
    if [ "$(stat -c %u "$DSH_HOME")" != "$RUNTIME_UID" ] \
       || [ "$(stat -c %u /workspace)" != "$RUNTIME_UID" ]; then
      echo "[dsh-entrypoint] fixing ownership of volume roots -> uid $RUNTIME_UID (volume was not writable by the runtime user)"
      chown -R "$RUNTIME_UID:$RUNTIME_GID" "$DSH_HOME"
      chown -R "$RUNTIME_UID:$RUNTIME_GID" /workspace
    else
      chown "$RUNTIME_UID:$RUNTIME_GID" "$DSH_HOME" /workspace
      # The profiles subtree (just created) must be owned by the runtime user
      # INCLUDING its parent, or dsh cannot create profiles/node_modules.
      chown -R "$RUNTIME_UID:$RUNTIME_GID" "$DSH_HOME/profiles"
    fi
  fi
else
  mkdir -p "$PROFILE_DIR" /workspace 2>/dev/null || true
fi

# 2) Write the webserver override patch once (never overwrite user edits).
#    dsh always binds loopback; the gate owns the public port in both modes.
BIND_HOST="127.0.0.1"
BIND_PORT="$DSH_INTERNAL_PORT"

if [ ! -f "$PROFILE_PATCH" ]; then
  if ! cat > "$PROFILE_PATCH" <<PATCH
# Managed by docker-entrypoint.sh — dsh web deployment overrides.
# Edit freely; this layer hot-reloads and user edits are never overwritten.
- id: webserver
  config:
    host: '$BIND_HOST'
    port: $BIND_PORT
PATCH
  then
    echo "[dsh-entrypoint] FATAL: cannot write $PROFILE_PATCH (Permission denied)." >&2
    echo "[dsh-entrypoint] The persistent volume at $DSH_HOME must be writable by uid $RUNTIME_UID," >&2
    echo "[dsh-entrypoint] or the container must start as root so the entrypoint can fix ownership." >&2
    exit 1
  fi
  if [ "$(id -u)" = "0" ] && [ "$RUNTIME_UID" != "0" ]; then
    chown "$RUNTIME_UID:$RUNTIME_GID" "$PROFILE_PATCH"
  fi
  echo "[dsh-entrypoint] wrote $PROFILE_PATCH (bind ${BIND_HOST}:${BIND_PORT})"
elif ! grep -q "port: $BIND_PORT" "$PROFILE_PATCH" \
  || ! grep -q "host: '$BIND_HOST'" "$PROFILE_PATCH"; then
  # Self-heal the managed webserver row when the host/port changed (including
  # volumes written by older images that bound 0.0.0.0); other user edits in
  # the patch are preserved. Previously this required deleting the file.
  node - "$PROFILE_PATCH" "$BIND_HOST" "$BIND_PORT" <<'NODE'
const [f, host, port] = process.argv.slice(2)
const fs = require('fs')
let d = fs.readFileSync(f, 'utf8')
const start = d.indexOf('- id: webserver')
if (start === -1) { console.error('[dsh-entrypoint] webserver row not found in patch'); process.exit(1) }
const next = d.indexOf('\n- id:', start + 3)
const end = next === -1 ? d.length : next
let block = d.slice(start, end)
const set = (key, val) => {
  const re = new RegExp('^\\s*' + key + ':.*$', 'm')
  block = re.test(block)
    ? block.replace(new RegExp('^(\\s*' + key + ':).*$', 'm'), '$1 ' + val)
    : block + '\n    ' + key + ': ' + val
}
set('host', "'" + host + "'")
set('port', port)
fs.writeFileSync(f, d.slice(0, start) + block + d.slice(end))
NODE
  if [ "$(id -u)" = "0" ] && [ "$RUNTIME_UID" != "0" ]; then
    chown "$RUNTIME_UID:$RUNTIME_GID" "$PROFILE_PATCH"
  fi
  echo "[dsh-entrypoint] updated webserver bind to ${BIND_HOST}:${BIND_PORT} (host/port change)"
fi

run_dsh() {
  # "$@" is the full argv to run; root stays root unless DSH_RUNTIME_UID is a
  # non-zero id, in which case privileges are dropped via setpriv.
  if [ "$(id -u)" = "0" ] && [ "$RUNTIME_UID" != "0" ]; then
    exec setpriv --reuid="$RUNTIME_UID" --regid="$RUNTIME_GID" --clear-groups \
      env HOME=/home/node DSH_HOME="$DSH_HOME" "$@"
  elif [ "$(id -u)" = "0" ]; then
    exec env HOME=/root DSH_HOME="$DSH_HOME" "$@"
  else
    exec env DSH_HOME="$DSH_HOME" "$@"
  fi
}

echo "[dsh-entrypoint] starting dsh web on ${BIND_HOST}:${BIND_PORT} (DSH_HOME=$DSH_HOME, build=$DSH_DOCKER_BUILD, auth=$AUTH_MODE, runtime_uid=$RUNTIME_UID)"

# dsh always runs in the background on loopback, regardless of auth mode. Its
# output is mirrored to the container log and the per-process launch token it
# prints is captured: the gate needs that token to mint dsh's browser cookie.
DSH_LOG="$DSH_HOME/dsh-web.log"
: > "$DSH_LOG"
run_dsh dsh web --no-open >"$DSH_LOG" 2>&1 &
DSH_PID=$!
tail -n +1 -F "$DSH_LOG" &
TAIL_PID=$!

READY=0
LAUNCH_TOKEN=""
for _ in $(seq 1 60); do
  if [ -s "$DSH_LOG" ]; then
    LAUNCH_TOKEN="$(sed -n 's/.*[?&]token=\([A-Za-z0-9_-]*\).*/\1/p' "$DSH_LOG" | head -n 1)"
  fi
  if [ -n "$LAUNCH_TOKEN" ] && curl -sf -o /dev/null "http://127.0.0.1:${DSH_INTERNAL_PORT}/?token=${LAUNCH_TOKEN}" 2>/dev/null; then
    READY=1
    break
  fi
  sleep 1
done
if [ "$READY" != "1" ]; then
  echo "[dsh-entrypoint] FATAL: dsh did not become ready on 127.0.0.1:${DSH_INTERNAL_PORT} (pid $DSH_PID)" >&2
  kill "$DSH_PID" "$TAIL_PID" 2>/dev/null || true
  exit 1
fi

if [ "$AUTH_MODE" = "0" ]; then
  echo "[dsh-entrypoint] dsh ready on 127.0.0.1:${DSH_INTERNAL_PORT}; starting pass-through gate on 0.0.0.0:${PORT}"
else
  echo "[dsh-entrypoint] dsh ready on 127.0.0.1:${DSH_INTERNAL_PORT}; starting auth gate on 0.0.0.0:${PORT}"
fi
export PORT DSH_INTERNAL_PORT
export DSH_AUTH_DIR="$DSH_HOME/auth"
export DSH_LAUNCH_TOKEN="$LAUNCH_TOKEN"
run_dsh node /usr/local/bin/auth-proxy.js
