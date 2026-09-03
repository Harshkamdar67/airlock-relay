#!/usr/bin/env bash
# Real end-to-end check of the resume path against a scratch Claude Code
# session, so the conversation you are actually working in is never touched.
#
# 1. uses (or creates) one small Claude Code session in a scratch directory
# 2. starts the bridge in REAL mode (no --dry-run) with --workdir = scratch
# 3. drives prepare, approve, execute through WebMCP in headless Chrome, clicks Resume
# 4. verifies a Claude Code process is running with --resume <scratch id>
#    and that the scratch transcript was written to, then stops that process
#
# Usage: bash scripts/resume-e2e.sh [route]   (route defaults to sonnet)
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
route="${1:-sonnet}"
port=4792
scratch="${RELAY_SCRATCH:-$HOME/relay-resume-scratch}"
mkdir -p "$scratch"
scratch_w="$scratch"
if command -v cygpath >/dev/null 2>&1; then scratch_w="$(cygpath -w "$scratch")"; fi

sid="$(python "$here/scripts/session_id.py" "$scratch_w")"
if [[ -z "$sid" ]]; then
  echo "== creating a small session in $scratch"
  (cd "$scratch" && timeout 120 claude -p "Reply with the single word ok" --model sonnet < /dev/null || true)
  sid="$(python "$here/scripts/session_id.py" "$scratch_w")"
fi
[[ -n "$sid" ]] || { echo "no scratch session id found"; exit 1; }
transcript="$(python "$here/scripts/session_id.py" "$scratch_w" --transcript)"
if command -v cygpath >/dev/null 2>&1; then transcript="$(cygpath -u "$transcript")"; fi
before="$(stat -c %Y "$transcript" 2>/dev/null || echo 0)"
echo "scratch session: $sid"
echo "transcript: $transcript (mtime $before)"

echo "== starting the bridge in real mode on :$port"
python "$here/bridge/relay.py" --port "$port" --workdir "$scratch_w" --task "resume e2e" --no-desktop-notify >"$scratch/bridge.log" 2>&1 &
bridge_pid=$!
trap 'kill $bridge_pid 2>/dev/null || true' EXIT
sleep 2

echo "== prepare, approve, execute, resume through WebMCP"
cd "$here"
RELAY_PORT="$port" RELAY_ROUTE="$route" node scripts/resume-drive.mjs

echo "== waiting for the resumed session to start"
sleep 30
echo "== processes carrying the scratch id:"
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.CommandLine -like '*$sid*' -and \$_.CommandLine -notlike '*resume-e2e*' -and \$_.CommandLine -notlike '*session_id.py*' } | Select-Object ProcessId, Name, @{n='Cmd';e={\$_.CommandLine.Substring(0, [Math]::Min(150, \$_.CommandLine.Length))}} | Format-Table -AutoSize | Out-String -Width 220"
after="$(stat -c %Y "$transcript" 2>/dev/null || echo 0)"
if [[ "$after" -gt "$before" ]]; then echo "transcript written by the resumed session (mtime $before -> $after)"; else echo "transcript not written yet (mtime $before -> $after)"; fi
echo "== stopping the resumed session"
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.CommandLine -like '*$sid*' -and \$_.CommandLine -notlike '*resume-e2e*' -and \$_.CommandLine -notlike '*session_id.py*' -and \$_.Name -match 'node|claude|bash|cmd|python' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue; 'stopped ' + \$_.ProcessId + ' ' + \$_.Name }"
tail -4 "$scratch/bridge.log"
