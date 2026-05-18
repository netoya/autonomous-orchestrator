#!/usr/bin/env bash
# Mantiene el visor dev server vivo. Si muere, lo relanza tras 2s.
# Util durante la construccion de la cadena visor — los agentes a veces lo matan accidentalmente.
set -u
VISOR_DIR="/home/angel/projects/visor-orchestrator"
LOG="/tmp/visor-dev.log"
PORT=5176

cd "$VISOR_DIR"

while true; do
  if ! curl -fs "http://localhost:${PORT}/api/health" -o /dev/null 2>&1; then
    echo "[$(date +%H:%M:%S)] server down, restarting..."
    # mata cualquier resto
    pkill -f "tsx --watch server/index.ts" 2>/dev/null || true
    sleep 1
    nohup npm run dev > "$LOG" 2>&1 &
    sleep 4
    if curl -fs "http://localhost:${PORT}/api/health" -o /dev/null 2>&1; then
      echo "[$(date +%H:%M:%S)] server UP (pid=$(pgrep -f 'tsx --watch server/index.ts' | head -1))"
    else
      echo "[$(date +%H:%M:%S)] server FAILED to start — see $LOG"
      tail -5 "$LOG"
    fi
  fi
  sleep 5
done
