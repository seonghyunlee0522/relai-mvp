#!/bin/bash
# Every 2 s: client connections by state (pg_stat_activity) and the DB container's memory → $OUT/db.jsonl. Stop with kill.
: "${OUT:=.}" "${CONTAINER:=relai-neonsim}"
while true; do
  c=$(docker exec "$CONTAINER" psql -U postgres -Atc "select count(*) filter (where backend_type='client backend'), count(*) filter (where state='active' and backend_type='client backend'), count(*) filter (where state='idle'), count(*) filter (where wait_event_type='Lock') from pg_stat_activity" 2>/dev/null | tr '|' ' ')
  m=$(docker stats --no-stream --format '{{.MemUsage}}' "$CONTAINER" 2>/dev/null | cut -d/ -f1 | tr -d ' ')
  set -- $c; echo "{\"t\":$(date +%s)000,\"conns\":${1:-null},\"active\":${2:-null},\"idle\":${3:-null},\"lockwait\":${4:-null},\"mem\":\"$m\"}" >> "$OUT/db.jsonl"
  sleep 2
done
