#!/bin/bash
# launch.sh -- start the BankPipe web app on a free port, then show it.
# Verifies it is really BankPipe responding, not another server that grabbed the port.
set -uo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$APP_DIR/data/app.log"
PORTFILE="$APP_DIR/data/port"
FIRST_PORT="${BANKPIPE_PORT:-8765}"
LAST_PORT=$((FIRST_PORT + 20))

mkdir -p "$APP_DIR/data"

is_bankpipe() {  # is BankPipe answering on this port?
  curl -fsS --max-time 2 "http://127.0.0.1:$1/__health" 2>/dev/null | grep -q '"app":"bankpipe"'
}

port_in_use() {  # does anything at all answer there?
  curl -fsS --max-time 1 "http://127.0.0.1:$1/" >/dev/null 2>&1
}

# 1. already running somewhere we remember?
if [ -f "$PORTFILE" ]; then
  remember=$(cat "$PORTFILE" 2>/dev/null)
  if [ -n "$remember" ] && is_bankpipe "$remember"; then
    open "http://127.0.0.1:$remember/"
    exit 0
  fi
fi

# 2. find a port: reuse ours, else take the first that is genuinely free
PORT=""
for p in $(seq "$FIRST_PORT" "$LAST_PORT"); do
  if is_bankpipe "$p"; then
    echo "$p" > "$PORTFILE"; open "http://127.0.0.1:$p/"; exit 0
  fi
  if ! port_in_use "$p"; then PORT="$p"; break; fi
done

if [ -z "$PORT" ]; then
  osascript -e "display alert \"No free port\" message \"Tried $FIRST_PORT to $LAST_PORT.\" as critical" >/dev/null 2>&1
  exit 1
fi

# 3. start the static app and wait for the health check
if ! command -v node >/dev/null 2>&1; then
  osascript -e 'display alert "Node is missing" message "BankPipe needs Node.js to serve its files. Install it from nodejs.org, then open BankPipe again." as critical' >/dev/null 2>&1
  exit 1
fi

cd "$APP_DIR/web" || exit 1
PORT="$PORT" nohup node server.mjs >> "$LOG" 2>&1 &
echo "$PORT" > "$PORTFILE"

for _ in $(seq 1 60); do
  if is_bankpipe "$PORT"; then
    open "http://127.0.0.1:$PORT/"
    exit 0
  fi
  sleep 0.25
done

osascript -e 'display alert "BankPipe did not start" message "Port '"$PORT"' did not answer. See ~/bankpipe/data/app.log." as critical' >/dev/null 2>&1
