#!/usr/bin/env bash
# Verify gate for the UIUX humanity-improvement loop.
# Passes (exit 0) only when: build is green AND the 9-task backlog in UIUX_VISION.md
# is fully completed per .loop/UIUX_state.json. Otherwise exits 1 so loop-engine.sh
# keeps iterating (this is intentional — we want N backlog tasks done, not "build once green").
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE_FILE="$ROOT/.loop/UIUX_state.json"

cd "$ROOT/frontend" || exit 1
echo "--- tsc --noEmit ---"
npx tsc --noEmit -p . || exit 1
echo "--- vite build ---"
npx vite build || exit 1

remaining=$(node -e "
  const fs = require('fs');
  const s = JSON.parse(fs.readFileSync('$STATE_FILE', 'utf8'));
  const total = (s.task_backlog || []).length;
  const done = (s.completed_tasks || []).length;
  console.log(total - done);
")

echo "backlog remaining: $remaining (completed=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$STATE_FILE','utf8')).completed_tasks.length)"))"

if [ "$remaining" -le 0 ]; then
  echo "All backlog tasks complete and build green. Definition of Done met."
  exit 0
fi

echo "Backlog not yet complete ($remaining remaining) — continue looping."
exit 1
