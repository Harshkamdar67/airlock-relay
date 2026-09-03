# Relay ingest contract

Any agent runtime can drive Relay by POSTing small JSON documents to the local bridge. Start the bridge with `--source generic` (or `--source claude-code`), then send:

```
POST http://127.0.0.1:4783/relay/api/ingest
Content-Type: application/json
```

## State

Tell the bridge what the session is. Send it once at start and whenever it changes.

```json
{ "state": { "session_id": "abc-123", "cwd": "/home/me/app", "model": "gpt-5.6-sol", "provider": "openai", "models": ["gpt-5.6-sol", "gpt-5.6-terra"] } }
```

| Field | Meaning |
| --- | --- |
| `session_id` | Identifier the runtime can resume from. Shown to the human and used in the resume command. |
| `cwd` | Working directory of the session. |
| `model` | Active model id. Use ids that match the route catalog for labels, or any string. |
| `provider` | `anthropic`, `openai`, `grok`, or `openrouter`. |
| `models` | Routes the session could move to. |
| `clear_cooldowns` | `true` to forget earlier failures. |

## Events

Send one per thing that happened. Only `kind` is required; the bridge writes a summary if you do not.

```json
{ "event": { "kind": "failure", "failure": "rate_limit", "summary": "429 from the provider after 3 retries" } }
{ "event": { "kind": "turn_completed", "summary": "Edited 4 files, tests pass" } }
{ "event": { "kind": "PostToolUse", "tool_name": "Bash" } }
```

`failure` values decide what the page shows as blocked:

| `failure` | Effect |
| --- | --- |
| `rate_limit`, `billing_error`, `account_on_hold`, `authentication_failed`, `oauth_org_not_allowed` | The whole provider is marked on cooldown for 15 minutes. |
| `overloaded`, `server_error`, `model_not_found`, `max_output_tokens` | Only the active model is marked on cooldown. |

Claude Code's hook event names (`SessionStart`, `PostToolUse`, `Stop`, `StopFailure`, `PreCompact`, `PostCompact`, `PostModelSwitch`, `SessionEnd`) are understood as kinds directly, which is what `bridge/claude_code_hook.py` sends.

## What the bridge does with it

- Composes the same diagnostics-shaped report the Airlock source produces, so the page and the WebMCP tools behave identically.
- Notifies you (desktop notification and optional webhook) the first time the session becomes blocked.
- Records approvals with one-shot nonces and refuses a switch without one.
- For `claude-code`, prepares `claude --resume <session_id> --model <target>` as the resume command. For `generic`, execution records the decision and the page shows it; wire your own resume by reading the executed handoff from the page or extending `resume_command()` in `bridge/relay.py`.

Everything is loopback only. The bridge never accepts connections from other hosts.
