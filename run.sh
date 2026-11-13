#!/usr/bin/env bash
# Start (or restart) the dashboard. Usage: ./run.sh [start|stop|status]
# TUNNEL=1 ./run.sh start  also opens a free Cloudflare quick tunnel (needs outbound port 7844).
set -u
cd "$(dirname "$0")"
PORT="${PORT:-8787}"
mkdir -p logs
stop() {
  for f in logs/server.pid logs/tunnel.pid; do
    [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null; rm -f "$f"
  done
  pkill -f "uvicorn backend.app:app --host 0.0.0.0 --port $PORT" 2>/dev/null
  pkill -f "cloudflared tunnel --url http://localhost:$PORT" 2>/dev/null
  sleep 1
}
status() {
  curl -s -m 5 "http://localhost:$PORT/healthz" && echo
  [ -f logs/public_url.txt ] && echo "Public: $(cat logs/public_url.txt)"
}
start() {
  stop
  setsid nohup .venv/bin/uvicorn backend.app:app --host 0.0.0.0 --port "$PORT" >> logs/server.log 2>&1 &
  echo $! > logs/server.pid
  for i in $(seq 1 30); do curl -s -m 2 "http://localhost:$PORT/healthz" >/dev/null && break; sleep 1; done
  echo "Local: http://localhost:$PORT"
  if [ "${TUNNEL:-0}" = "1" ] && command -v cloudflared >/dev/null; then
    : > logs/tunnel.log
    setsid nohup cloudflared tunnel --no-autoupdate --protocol http2 --url "http://localhost:$PORT" >> logs/tunnel.log 2>&1 &
    echo $! > logs/tunnel.pid
    for i in $(seq 1 40); do
      URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' logs/tunnel.log | head -1)
      [ -n "$URL" ] && break; sleep 1
    done
    if [ -n "${URL:-}" ]; then echo "$URL" > logs/public_url.txt; echo "Public: $URL (check it loads; see logs/tunnel.log)"; else echo "Tunnel URL not found; see logs/tunnel.log"; fi
  fi
}
case "${1:-start}" in start) start;; stop) stop;; status) status;; *) echo "usage: $0 [start|stop|status]";; esac
