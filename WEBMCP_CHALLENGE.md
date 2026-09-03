# What was built for the WebMCP Challenge

[Airlock](https://github.com/Harshkamdar67/Airlock) existed before the challenge. It is a launcher and local router that lets one Claude Code session use Anthropic, OpenAI, Grok, and OpenRouter models, with rate-limit cooldowns, failover chains, and a loopback `GET /diagnostics` endpoint that records what the router did. None of that is entered here.

**Everything in this repository was written on 2026-09-03, during the submission period.** The commit history is the record.

| Area | New for the challenge | Files |
| --- | --- | --- |
| WebMCP tool surface | Seven tools with JSON Schemas, annotations, bounded results, structured errors, registered via `document.modelContext.registerTool`. | `src/webmcp/tools.ts`, `src/webmcp/register.ts` |
| Shared human and agent state | One store both parties mutate, with actor attribution, revisions, approval tokens bound to a revision, idempotent execution. | `src/runtime/state.ts`, `src/runtime/types.ts` |
| Control room UI | Session, routes, editable handoff proposal with Approve and Reject, agent activity rail, runtime events, replay. | `src/ui/` |
| Airlock adapter | Turns a router diagnostics report into route availability and readable events. Used by both demo and live modes. | `src/runtime/airlock-adapter.ts` |
| Demo sessions | Two deterministic scenarios (rate limit, context overflow) built from router-shaped diagnostics reports, with real and seeded events labelled, plus per-provider plan headroom on every route. | `src/runtime/demo.ts`, `fixtures/` |
| Live bridge | Loopback Python bridge feeding the page from a running Airlock router and applying approved handoffs with Airlock's own command. | `bridge/relay.py`, `bridge/test_relay.py` |
| Scripted walkthrough | A no-agent path through the same tool entry point, for browsers without WebMCP. | `src/webmcp/walkthrough.ts` |
| Tests | 22 Vitest tests on policy (metered, cooldown, context window), approval, staleness, idempotency, and attribution; 9 bridge tests including the approval nonce; a Chrome smoke test that drives the tools through `executeTool`. | `tests/`, `bridge/test_relay.py`, `scripts/webmcp-smoke.mjs` |

## What Airlock itself provides (pre-existing, not judged)

- The router's diagnostics report shape, event kinds, and cooldown lists that the adapter reads.
- The `airlock handoff set` command the bridge calls after an approved handoff.
- The model catalog the routes are drawn from.

No Airlock source is vendored here. The Airlock repository was not modified for this submission.

## Honesty notes

- The hosted demo simulates the runtime after loading real router data. The page labels every event as `airlock` (copied from a real report), `scenario` (seeded), or `relay` (produced by this page).
- The demo session card's task, id, checkpoint, and worktree are invented. The events, cooldown lists, and usage totals underneath come from the router export.
- In live mode the bridge reports real router state, records the human's approval itself, and persists the approved chain order with Airlock's own command only when the page presents the matching one-shot nonce. It does not restart a running Claude Code process; that is the launcher's job in Airlock and is out of scope here.
