#!/bin/bash
# Deploy the booking app — the ONLY way to deploy (Lisa's stability rule: evenings,
# nothing silent). Runs both test suites first and refuses to deploy if either fails;
# then uploads to Railway and waits until the new version answers on the live URL.
#   bash scripts/deploy.sh
cd "$(dirname "$0")/.." || exit 1
LOG=$(mktemp)
echo "1/4 server checks…"
if ! node tests/smoke.js > "$LOG" 2>&1; then tail -5 "$LOG"; echo "STOP: server checks failed — not deploying"; exit 1; fi
tail -1 "$LOG"
echo "2/4 browser flows (about 2 minutes)…"
if ! node tests/e2e-schedule.js > "$LOG" 2>&1; then grep -E "✗|FAILED|ERROR" "$LOG"; echo "STOP: browser flows failed — not deploying"; exit 1; fi
grep -E "PASSED" "$LOG"
OLD=$(curl -s --max-time 10 https://booking.mpmodelsbkk.com/api/version)
echo "3/4 uploading (live is $OLD)…"
railway up --detach 2>&1 | grep -E "Build Logs|rror"
echo "4/4 waiting for the new version…"
for i in $(seq 1 60); do
  NEW=$(curl -s --max-time 10 https://booking.mpmodelsbkk.com/api/version)
  if [ -n "$NEW" ] && [ "$NEW" != "$OLD" ]; then echo "LIVE: $NEW after ~$((i*10))s — commit $(git log -1 --format=%h)"; exit 0; fi
  sleep 10
done
echo "still $OLD after 10 minutes — check the Railway build logs"; exit 1
