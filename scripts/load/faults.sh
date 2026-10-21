#!/bin/bash
# Run the section-4 fault scenarios. Needs the relai-neonsim container. OUT=… scripts/load/faults.sh
cd "$(dirname "$0")/../.."
: "${OUT:?}"; rm -rf "$OUT"; mkdir -p "$OUT"
P="docker exec relai-neonsim psql -U postgres -q"
$P -c "drop database if exists relai_fault with (force)" -c "do \$\$ begin if not exists (select 1 from pg_roles where rolname='app') then create role app login password 'sim'; end if; if not exists (select 1 from pg_roles where rolname='hog') then create role hog login password 'sim'; end if; end \$\$" -c "create database relai_fault owner app"
node scripts/load/faultproxy.mjs > "$OUT/proxy.log" 2>&1 & PX=$!
node scripts/load/mock-openai.mjs > "$OUT/mock.log" 2>&1 & MK=$!
export DATABASE_URL=postgres://app:sim@127.0.0.1:55491/relai_fault AI_REQUEST_TIMEOUT_MS=5000 AI_USER_MINUTE_LIMIT=0
OUT=$OUT N=2 CONCURRENCY=50 scripts/load/cluster.sh
until curl -sf -m 60 127.0.0.1:4100/health >/dev/null; do sleep 1; done
OUT=$OUT node scripts/load/faults.mjs | tee "$OUT/faults.out"
kill $(cat "$OUT/pids"); sleep 1
# S7: cold boot with the DB refusing, then the DB comes back — no restart
curl -s "127.0.0.1:55492/mode?m=refuse" >/dev/null
mkdir -p "$OUT/cold"; OUT=$OUT/cold N=1 scripts/load/cluster.sh
{ for i in 1 2; do s=$(date +%s%N); c=$(curl -s -o /tmp/cold.$$ -w '%{http_code}' -m 60 127.0.0.1:4100/health); echo "{\"label\":\"cold boot, DB refused #$i\",\"status\":$c,\"ms\":$(( ($(date +%s%N)-s)/1000000 )),\"body\":\"$(head -c 80 /tmp/cold.$$)\",\"retry_after\":\"$(curl -sI -m 60 127.0.0.1:4100/health | tr -d '\r' | grep -i retry-after | cut -d' ' -f2)\"}"; done
  curl -s "127.0.0.1:55492/mode?m=normal" >/dev/null
  s=$(date +%s%N); c=$(curl -s -o /dev/null -w '%{http_code}' -m 60 127.0.0.1:4100/health); echo "{\"label\":\"DB back, same instance (no restart)\",\"status\":$c,\"ms\":$(( ($(date +%s%N)-s)/1000000 ))}"; } | tee "$OUT/cold.jsonl"
grep -c "boot: db not ready" "$OUT"/cold/inst-*.log | sed 's/^/boot retries logged: /'
kill $(cat "$OUT/cold/pids") $PX $MK 2>/dev/null
grep -h -E "\[db\]|boot|Error|error" "$OUT"/inst-*.log | cut -c1-200 | sort | uniq -c | sort -rn | head -25 > "$OUT/log-summary.txt"; cat "$OUT/log-summary.txt"
