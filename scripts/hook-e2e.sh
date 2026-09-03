#!/usr/bin/env bash
# End-to-end check of the plain Claude Code adapter with the real `claude` CLI.
# Starts a bridge in claude-code mode on a spare port, installs the hooks in a
# scratch project, runs Claude Code once against a dead endpoint (to provoke a
# real StopFailure) and once for real with a one-word prompt, then reads the
# bridge state. Usage: bash scripts/hook-e2e.sh [--with-real-call]
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
port=4791
scratch="$(mktemp -d)"
hook="$here/bridge/claude_code_hook.py"
hook_win="$hook"
if command -v cygpath >/dev/null 2>&1; then hook_win="$(cygpath -m "$hook")"; fi
mkdir -p "$scratch/.claude"
python - "$scratch/.claude/settings.local.json" "$hook_win" <<'PY'
import json, sys
path, hook = sys.argv[1], sys.argv[2]
cmd = f'python "{hook}"'
h = lambda: [{"hooks": [{"type": "command", "command": cmd, "timeout": 3}]}]
settings = {"hooks": {
    "SessionStart": h(), "PostToolUse": h(), "Stop": h(), "SessionEnd": h(),
    "StopFailure": [{"matcher": m, "hooks": [{"type": "command", "command": cmd, "timeout": 3}]} for m in ["rate_limit", "overloaded", "billing_error", "server_error", "model_not_found", "max_output_tokens", "unknown", "invalid_request", "authentication_failed"]],
}}
json.dump(settings, open(path, "w"), indent=1)
PY
python "$here/bridge/relay.py" --source claude-code --port "$port" --workdir "$scratch" --task "hook e2e" --no-desktop-notify --dry-run >"$scratch/bridge.log" 2>&1 &
bridge_pid=$!
trap 'kill $bridge_pid 2>/dev/null || true' EXIT
sleep 2
export RELAY_URL="http://127.0.0.1:$port"
cd "$scratch"
echo "== provoking a real StopFailure (bad key against the real endpoint)"
env -u AIRLOCK_SESSION_ROUTER_URL ANTHROPIC_BASE_URL="https://api.anthropic.com" ANTHROPIC_API_KEY="sk-ant-relay-invalid" ANTHROPIC_AUTH_TOKEN="" timeout 60 claude -p "Reply with the single word ok" --model sonnet >"$scratch/fail.out" 2>&1 || true
tail -c 300 "$scratch/fail.out"; echo
if [[ "${1:-}" == "--with-real-call" ]]; then
  echo "== one real call"
  timeout 120 claude -p "Reply with the single word ok" --model sonnet >"$scratch/ok.out" 2>&1 || true
  tail -c 200 "$scratch/ok.out"; echo
fi
echo "== bridge state"
curl -s "http://127.0.0.1:$port/relay/api/state" | python -c "
import json, sys
d = json.load(sys.stdin)
print('session_id:', d['bridge']['session_id'])
print('blocked:', d['diagnostics']['rate_limit_provider_cooldowns'], d['diagnostics']['rate_limit_cooldowns'])
for e in d['diagnostics']['events']:
    print(' ', e['kind'], '|', e.get('summary'), '|', e.get('failure', ''))
"
echo "== bridge log tail"; tail -5 "$scratch/bridge.log"
