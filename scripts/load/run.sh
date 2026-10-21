#!/bin/bash
# One measured run: fresh cluster → monitor → VUS users for DURATION s → analysis in $OUT/summary.json.
#   DATABASE_URL=… VUS=30 DURATION=300 N=20 CONCURRENCY=10 OUT=… scripts/load/run.sh
cd "$(dirname "$0")/../.."
: "${OUT:?}" "${VUS:=10}" "${DURATION:=300}" "${N:=20}" "${CONCURRENCY:=10}"
rm -rf "$OUT"; mkdir -p "$OUT"
OUT=$OUT N=$N CONCURRENCY=$CONCURRENCY scripts/load/cluster.sh
until curl -sf -m 60 127.0.0.1:4100/health >/dev/null; do sleep 1; done
OUT=$OUT scripts/load/monitor.sh & MON=$!
BASE=http://127.0.0.1:4100 VUS=$VUS DURATION=$DURATION OUT=$OUT node scripts/load/load.mjs > "$OUT/load.log" 2>&1
sleep 12   # idle pool clients close after 5 s: watch the connection count fall back
kill $MON; kill $(cat "$OUT/pids") 2>/dev/null; sleep 1
node scripts/load/analyze.mjs "$OUT" > "$OUT/summary.json"; cat "$OUT/summary.json" | head -30
