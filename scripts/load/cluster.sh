#!/bin/bash
# Start N simulated Vercel instances (prod handler + pool settings, NODE_ENV=production, fake e-mail/AI/Jira) behind lb.mjs.
#   DATABASE_URL=postgres://… N=8 CONCURRENCY=30 OUT=/tmp/run1 scripts/load/cluster.sh   (stop: kill $(cat $OUT/pids))
set -e
cd "$(dirname "$0")/../.."
: "${N:=8}" "${CONCURRENCY:=30}" "${OUT:=$TMPDIR/relai-load}" "${LB_PORT:=4100}"
mkdir -p "$OUT"; : > "$OUT/pids"
export NODE_ENV=production SESSION_SECRET="load-$(date +%s)" INTEGRATION_ENCRYPTION_KEY="$(openssl rand -base64 32)" EMAIL_PROVIDER=fake \
  AI_ENABLED=true AI_PROVIDER="${AI_PROVIDER:-openai}" OPENAI_API_KEY=sk-fake OPENAI_BASE_URL="${OPENAI_BASE_URL:-http://127.0.0.1:4199/v1}" \
  INTEGRATION_PROVIDER="${INTEGRATION_PROVIDER:-fake}" SAMPLE_PROJECTS=true APP_BASE_URL=https://relai.test PAYMENTS_ENABLED=false CRON_SECRET=x MEM_LOG="$OUT/mem.jsonl"
PORTS=""
for i in $(seq 1 "$N"); do p=$((LB_PORT + i)); PORTS="$PORTS${PORTS:+,}$p"
  PORT=$p node scripts/load/instance.mjs > "$OUT/inst-$p.log" 2>&1 & echo $! >> "$OUT/pids"; done
PORTS=$PORTS CONCURRENCY=$CONCURRENCY LB_PORT=$LB_PORT LB_LOG="$OUT/lb.jsonl" node scripts/load/lb.mjs > "$OUT/lb.log" 2>&1 & echo $! >> "$OUT/pids"
sleep 1; echo "cluster up: lb :$LB_PORT → $PORTS (out $OUT)"
