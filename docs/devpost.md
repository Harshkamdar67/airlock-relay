# Devpost submission text

Copy each section into the matching Devpost field.

## Project name

Airlock Relay

## Tagline (max ~120 chars)

A WebMCP control room where you and a browser agent supervise a stuck coding-agent session together.

## Live URL

https://harshkamdar67.github.io/airlock-relay/

## Repository

https://github.com/Harshkamdar67/airlock-relay

## Video

(paste the YouTube link)

## Built with

WebMCP, TypeScript, Vite, Vitest, Python, GitHub Pages, Airlock

## Description

### Inspiration

I run coding agents for hours through Airlock, a launcher I built that lets one Claude Code session use Anthropic, OpenAI, Grok, and OpenRouter models. The failure I hit most is boring and expensive: the active model's plan gets rate limited mid-task, the session stops, and I am the one who has to read logs, work out which model is free, whether it costs extra, and how to resume without losing the checkpoint. A browser agent could do that reading for me, but only if it can understand the runtime, and nobody wants an agent switching their models on its own.

### What it does

Airlock Relay is a web page that a human and a browser agent operate at the same time.

The human sees the session (task, active model, blocked or running, context, checkpoint), every route with its provider, tier, cooldown, and whether it spends metered usage, and a handoff proposal they can edit, approve, or reject.

The agent sees the same state through seven WebMCP tools: `get_session`, `get_events`, `get_routes`, `prepare_handoff`, `get_handoff`, `execute_handoff`, and `get_replay`. It inspects what went wrong, proposes a handoff to a ready non-metered route that fits the session's context, and is refused if it tries to execute early. Two scenarios ship: a rate-limited Anthropic plan where only a metered Claude route or another provider can continue, and a context overflow where a 412k-token conversation needs a route with a bigger window, so the page refuses routes without room and lists the ones that fit. Every route carries its provider's plan headroom too. The human can change the target in the page, for example to a metered Claude route, and approve. The agent re-reads the proposal, sees the human's change and the fact that the human accepted metered usage, and executes with the approval token. The session resumes from its checkpoint and the replay shows who did what, in order.

There is no approve tool on purpose. Approve is a button. Approval issues a token bound to the proposal's revision, and any edit revokes it, so "the human decides" is enforced by the page rather than by convention. In live mode the local bridge records the approval too and refuses to run the real Airlock command without its own one-shot nonce.

### How WebMCP is used

Tools are registered on load with `document.modelContext.registerTool`, each with a JSON Schema, a use-case description, and annotations: reads carry `readOnlyHint`, and the event log carries `untrustedContentHint` because summaries relay upstream provider text. Results are bounded and every error is structured with a code, a message, and a hint so the agent can self-correct: `METERED_ROUTE_REQUIRES_OPT_IN` lists non-metered alternatives, `APPROVAL_REQUIRED` tells the agent to ask the human and poll `get_handoff`, `STALE_APPROVAL` explains that the human edited after approving.

The same handlers serve WebMCP, a scripted walkthrough for browsers without WebMCP, and the tests. A Chrome smoke test drives the whole flow through `document.modelContext.executeTool` rather than through the page's own functions.

### How it improves the experience

Before: a person at a terminal, reading router diagnostics and guessing. Or a browser agent clicking through a dashboard it does not understand.

After: the page declares what a session, a route, and a handoff are. The agent does the reading and proposing; the human keeps the decision with one click; both work on one object and both see each other's actions. The replay makes the collaboration auditable.

### Real data, honestly labelled

The hosted demo is built from a real `GET /diagnostics` export from an Airlock router on 2026-09-03. Events copied verbatim are tagged `airlock`; events seeded to put the session into the blocked state are tagged `scenario`, in the router's exact event shapes; events produced by the page are tagged `relay`. The demo session card's task, checkpoint, and worktree are invented; the router data under it is real. A standard-library Python bridge runs the same page in live mode against a real Airlock session on your machine. It discovers the router and the Claude Code session id, pushes a notification when the session blocks, records the human's approval itself, persists the approved order with Airlock's own `airlock handoff set`, and offers a human-only button that opens a terminal running `airlock hybrid <route> --resume <session-id>`, so the same conversation continues on the approved model. I built the live mode because I want to use it myself. It is not tied to Airlock: plain Claude Code plugs in through its hooks (`StopFailure` is the block signal, `claude --resume --model` is the switch), and any agent runtime can drive the same page by POSTing small JSON events to a documented ingest endpoint. Desktop and webhook notifications (ntfy, Slack, Discord) fire when a session blocks. The live paths were exercised for real: the bridge ran `airlock handoff set` on a real Airlock install through the approval gate, and real Claude Code sessions posted SessionStart, Stop, and SessionEnd into the bridge through the hooks. The README lists exactly what was verified and how.

### What is new for the challenge

Airlock existed before August 25. Everything in the airlock-relay repository was written on 2026-09-03: the WebMCP tool surface, the shared state with revisions and approval tokens, the control room, the adapter, the demo, the live bridge, the walkthrough, and the tests. See WEBMCP_CHALLENGE.md in the repo for the file-level breakdown.

### Challenges

Chrome serialises whatever a tool's `execute` returns into a JSON string, so returning MCP-style content arrays double-encoded the result; returning the plain result object gives agents one level of JSON. Getting the approval semantics right took care: a token bound to a revision, revoked on any edit, with idempotent execution so a retry after a network blip cannot resume the session twice.

### What's next

Ship the bridge as `airlock relay` inside Airlock itself, read live plan headroom from Claude Code's status line so the route data in live mode matches the demo, and let the agent subscribe to events instead of polling.

## Gallery images (upload in this order)

1. `docs/screenshot-blocked.png` — blocked session, tools registered, prompt ready.
2. `docs/screenshot-after-handoff.png` — proposal edited by the human, approved, executed; replay and activity visible.
3. `docs/screenshot-overflow.png` — context overflow scenario with routes marked fit / no room.
4. `docs/screenshot-live-mode.png` — live mode against a real Airlock router with the resume command.
5. `docs/screenshot-claude-code.png` — plain Claude Code session fed by hooks.

## Testing instructions (Devpost field)

1. Open https://harshkamdar67.github.io/airlock-relay/ in the ChatGPT desktop app's browser, or in Chrome 149+ with chrome://flags/#enable-webmcp-testing enabled and relaunched. The top bar should read "WebMCP: 7 tools registered".
2. Ask the agent: "My Airlock coding session looks blocked. Inspect what happened, then get it running again on a route that is ready and does not spend metered usage. Do not change the active model until I approve the handoff in this page."
3. The agent should call get_session, get_events, get_routes, then prepare_handoff to a ready non-metered route (GPT-5.6 Sol). If it calls execute_handoff early, the page refuses with APPROVAL_REQUIRED.
4. In the Handoff proposal card, change "To" to Claude Fable 5.1 (metered) and click Approve.
5. Tell the agent "continue". It should call get_handoff, see your change and approval, and call execute_handoff. The session shows running on Claude Fable 5.1 from checkpoint cp_184, and the Replay lists runtime, agent, and human actions in order.
6. Optional: click Reset demo and try rejecting the proposal, or edit the target after approving to see the token revoked (STALE_APPROVAL).
6b. Switch the scenario selector to "Context overflow" and ask the agent the same thing. It should discover that GPT-5.6 Terra and Luna do not fit 412k tokens (prepare_handoff returns CONTEXT_EXCEEDS_ROUTE_WINDOW with routes that fit) and propose Grok 4.6 or Claude Opus 5.
7. No WebMCP available: click "Run scripted walkthrough"; it pauses at approval and finishes after you approve.
8. No login is required. Nothing is stored server-side.
