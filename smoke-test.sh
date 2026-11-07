#!/bin/bash
# smoke-test.sh — scripted smoke tests for the deepseek-harness image.
#
# Usage: ./smoke-test.sh [image-tag]
#   image-tag defaults to deepseek-harness:0.2.2-rc.1
#
# Covers (auth mode is the default):
#   - entrypoint/profile init, gate on 0.0.0.0:PORT, dsh on 127.0.0.1 only
#   - password gate: no registration page with DSH_AUTH_PASSWORD, wrong/right
#     password, unauthenticated /api -> 401, authenticated forward + __DSH_BOOT__
#   - sandbox: Landlock probe + real confined bash run
#   - persistence across restart (password still works)
#   - legacy mode (DSH_AUTH=0): gate pass-through without a password still works
#   - healthcheck healthy
set -euo pipefail

IMAGE="${1:-deepseek-harness:0.2.2-rc.1}"
NAME="dsh-smoke"
VOL="dsh-smoke-data"
PORT="${SMOKE_PORT:-3081}"
PASSWORD="SmokePass123"
FAILED=0

say()  { printf '\n==> %s\n' "$*"; }
ok()   { printf '    [PASS] %s\n' "$*"; }
fail() { printf '    [FAIL] %s\n' "$*"; FAILED=1; }

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

say "starting container from $IMAGE (auth mode, DSH_AUTH_PASSWORD set)"
docker run -d --name "$NAME" \
  -p "$PORT:3080" \
  -v "$VOL:/data" \
  -e DSH_HOME=/data \
  -e PORT=3080 \
  -e DSH_AUTH_PASSWORD="$PASSWORD" \
  "$IMAGE" >/dev/null

for i in $(seq 1 40); do
  docker logs "$NAME" 2>&1 | grep -q 'auth] gate listening' && break
  sleep 1
done

say "gate serves the public port, dsh stays on loopback"
docker exec "$NAME" grep -q '00000000:0C08' /proc/net/tcp \
  && ok "gate listening 0.0.0.0:3080" || fail "gate not on 0.0.0.0:3080"
docker exec "$NAME" grep -q '0100007F:0C09' /proc/net/tcp \
  && ok "dsh on 127.0.0.1:3081 only" || fail "dsh not loopback-only"

say "runtime user is root by default"
init_user=$(docker exec "$NAME" ps -o user= -p 1 2>/dev/null | tr -d ' ')
[ "$init_user" = "root" ] && ok "pid 1 runs as root" || fail "pid 1 user: $init_user"
node_users=$(docker exec "$NAME" sh -c 'for p in /proc/[0-9]*; do case "$(readlink "$p/exe" 2>/dev/null)" in */node) stat -c %U "$p" 2>/dev/null;; esac; done; true' | sort -u) || true
if [ -z "$node_users" ]; then
  fail "no node process found to inspect"
elif [ "$node_users" = "root" ]; then
  ok "dsh/auth node processes run as root"
else
  fail "node processes run as: $(echo "$node_users" | tr '\n' ' ')"
fi

say "password gate"
curl -s -o /dev/null -w '%{http_code}' -H 'Accept: text/html' "http://127.0.0.1:$PORT/" > /tmp/smoke-code
[ "$(cat /tmp/smoke-code)" = "302" ] \
  && ok "unauthenticated navigation -> 302 (login page)" || fail "expected 302, got $(cat /tmp/smoke-code)"
curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/health" > /tmp/smoke-code
[ "$(cat /tmp/smoke-code)" = "401" ] \
  && ok "unauthenticated /api -> 401" || fail "expected 401, got $(cat /tmp/smoke-code)"
curl -s -X POST -d 'password=WrongPass' "http://127.0.0.1:$PORT/login" | grep -q '密码错误' \
  && ok "wrong password rejected" || fail "wrong password accepted"

say "login + authenticated forward"
JAR=$(mktemp)
curl -s -D /tmp/smoke-h -o /dev/null -c "$JAR" -X POST -d "password=$PASSWORD" "http://127.0.0.1:$PORT/login"
COOKIE=$(grep -i '^set-cookie:' /tmp/smoke-h | sed 's/^[Ss]et-[Cc]ookie: //' | cut -d';' -f1)
[ -n "$COOKIE" ] && ok "login issues session cookie" || fail "no cookie"
curl -s -L -c "$JAR" -b "$JAR" "http://127.0.0.1:$PORT/" | grep -q '__DSH_BOOT__' \
  && ok "authenticated page served with __DSH_BOOT__" || fail "no boot manifest"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "http://127.0.0.1:$PORT/api/health")
if [ "$code" != "401" ] && [ "$code" != "403" ]; then
  ok "authenticated /api forwarded through gate (passed auth + fence, status $code)"
else
  fail "authenticated /api -> $code"
fi

say "websocket upgrade"
WS=$(curl -sS -i -N --http1.1 --max-time 3 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  -b "$JAR" "http://127.0.0.1:$PORT/api/remote.mux" 2>&1 || true)
if echo "$WS" | grep -q '101 Switching Protocols' && echo "$WS" | grep -qi 'Sec-WebSocket-Accept:'; then
  ok "websocket handshake forwards Sec-WebSocket-Accept"
else
  fail "websocket handshake failed: $(echo "$WS" | head -1)"
fi

say "sandbox: launcher availability (host may block Landlock/bwrap)"
probe=$(docker exec "$NAME" sh -c 'cd /usr/local/lib/node_modules/@deepseek-ai/dsh && node -e "
const m=require(\"@deepseek-ai/node-addon-system/landlock-run\");
console.log(m.probe(m.launcherPath()));"' 2>/dev/null || echo error)
case "$probe" in
  full|partial)
    ok "landlock probe: $probe"
    out=$(docker exec "$NAME" sh -c 'cd /usr/local/lib/node_modules/@deepseek-ai/dsh && node -e "
const {spawn}=require(\"child_process\");
const m=require(\"@deepseek-ai/node-addon-system/landlock-run\");
const argv=[m.launcherPath(),...m.grantArgs({readOnly:[\"/\"],readWrite:[\"/tmp\",\"/workspace\"]}),\"--\",\"bash\",\"-c\",\"echo SANDBOX_OK\"];
spawn(argv[0],argv.slice(1)).stdout.on(\"data\",d=>process.stdout.write(d));"')
    [ "$out" = "SANDBOX_OK" ] && ok "confined bash works" || fail "confined bash failed: $out"
    ;;
  unusable)
    docker exec "$NAME" test -x /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/landlock-run \
      && ok "landlock launcher present; host kernel/policy blocks enforcement (environment limitation)" \
      || fail "landlock launcher missing"
    ;;
  *)
    fail "landlock probe failed: $probe"
    ;;
esac

say "persistence across restart (password must still work)"
docker restart "$NAME" >/dev/null
# Poll the port (logs still contain the previous run's lines, so grep is unreliable)
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/login" || true)
  [ "$code" != "000" ] && break
  sleep 1
done
JAR2=$(mktemp)
curl -s -o /dev/null -w '%{http_code}' -c "$JAR2" -X POST -d "password=$PASSWORD" "http://127.0.0.1:$PORT/login" > /tmp/smoke-code
[ "$(cat /tmp/smoke-code)" = "302" ] \
  && ok "login works after restart" || fail "login after restart -> $(cat /tmp/smoke-code)"
curl -s -L -c "$JAR2" -b "$JAR2" "http://127.0.0.1:$PORT/" | grep -q '__DSH_BOOT__' \
  && ok "page boots after restart (fresh dsh launch token)" || fail "page boot after restart failed"

say "legacy mode (DSH_AUTH=0) boots without a password via gate pass-through"
docker stop "$NAME" >/dev/null 2>&1 || true
NAME="${NAME}-legacy"
docker run -d --name "$NAME" -p "$PORT:3080" -v "$VOL:/data" \
  -e DSH_HOME=/data -e PORT=3080 -e DSH_AUTH=0 "$IMAGE" >/dev/null
for i in $(seq 1 40); do
  docker logs "$NAME" 2>&1 | grep -q 'gate listening' && break
  sleep 1
done
JAR3=$(mktemp)
curl -s -L -c "$JAR3" -b "$JAR3" "http://127.0.0.1:$PORT/" | grep -q '__DSH_BOOT__' \
  && ok "legacy direct access works (no password, gate pass-through)" || fail "legacy boot failed"

say "final health"
for i in $(seq 1 12); do
  h=$(docker inspect -f '{{.State.Health.Status}}' "$NAME" 2>/dev/null || echo unknown)
  [ "$h" = "healthy" ] && break
  sleep 5
done
h=$(docker inspect -f '{{.State.Health.Status}}' "$NAME")
[ "$h" = "healthy" ] && ok "healthcheck healthy" || fail "healthcheck: $h"

echo
if [ "$FAILED" = "0" ]; then
  echo "ALL SMOKE TESTS PASSED"
else
  echo "SOME TESTS FAILED"
fi
exit "$FAILED"
