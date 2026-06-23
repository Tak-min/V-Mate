#!/usr/bin/env bash
# Verify gate for the UX retention/engagement loop (round 2).
#
# IMPORTANT lesson from round 1 (.loop/UIUX_VISION.md "前回の反省"): this script's
# stdout is hashed by loop-engine.sh to detect "no progress" (identical hash N times
# in a row). `npx vite build`'s own stdout contains a non-deterministic build-time
# string ("built in 1.23s") that differs every run even when nothing changed, which
# silently defeated no-progress detection last round and wasted 17 iterations on a
# dead claude -p (session limit hit). This script therefore captures build output to
# a log file (not stdout) and only echoes a STABLE status line + backlog count.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE_FILE="$ROOT/.loop/UX_state.json"
BUILD_LOG="$ROOT/.loop/ux/build.log"
mkdir -p "$ROOT/.loop/ux"

cd "$ROOT/frontend" || exit 1
{
  echo "--- tsc --noEmit (frontend) ---"
  npx tsc --noEmit -p .
} > "$BUILD_LOG" 2>&1
frontend_rc=$?
if [ "$frontend_rc" -ne 0 ]; then
  echo "frontend tsc: FAIL (see .loop/ux/build.log)"
  exit 1
fi

{
  echo "--- vite build ---"
  npx vite build
} >> "$BUILD_LOG" 2>&1
vite_rc=$?
if [ "$vite_rc" -ne 0 ]; then
  echo "vite build: FAIL (see .loop/ux/build.log)"
  exit 1
fi
echo "frontend build: OK"

# Worker (backend) type-check only if tasks touched it — cheap enough to always run.
if [ -d "$ROOT/worker" ]; then
  (cd "$ROOT/worker" && npx tsc --noEmit -p . ) >> "$BUILD_LOG" 2>&1
  worker_rc=$?
  if [ "$worker_rc" -ne 0 ]; then
    echo "worker tsc: FAIL (see .loop/ux/build.log)"
    exit 1
  fi
  echo "worker tsc: OK"
fi

remaining=$(node -e "
  const fs = require('fs');
  const s = JSON.parse(fs.readFileSync('$STATE_FILE', 'utf8'));
  const total = (s.task_backlog || []).length;
  const done = (s.completed_tasks || []).length;
  const skipped = (s.skipped_tasks || []).length;
  console.log(total - done - skipped);
")

echo "backlog remaining: $remaining"

if [ "$remaining" -le 0 ]; then
  echo "All backlog tasks complete/skipped and build green. Definition of Done met."
  exit 0
fi

echo "Backlog not yet complete ($remaining remaining) — continue looping."
exit 1
