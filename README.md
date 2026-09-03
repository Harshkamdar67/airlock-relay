# Airlock Relay

**A WebMCP control room where a human and a browser agent supervise a live coding-agent session together, and hand it between model providers without losing the work.**

Live demo: **https://harshkamdar67.github.io/airlock-relay/**
Built for [The WebMCP Challenge](https://webmcp.devpost.com/) on top of [Airlock](https://github.com/Harshkamdar67/Airlock). What is new for the challenge is listed in [WEBMCP_CHALLENGE.md](WEBMCP_CHALLENGE.md).

![Airlock Relay after a handoff](docs/screenshot-after-handoff.png)

## The problem

Coding agents like Claude Code run for hours on one model. When that model's plan hits a rate limit at 2 AM, the session stops and a person has to work out what happened, which other model is available, whether it costs extra, and how to resume without losing the checkpoint. Airlock already routes one Claude Code session across Anthropic, OpenAI, Grok, and OpenRouter models and records every rate limit, cooldown, and failover on a local router. Until now the only way to supervise that runtime was a terminal.

Airlock Relay turns the runtime into a web page that two parties operate at once:

- **The human** sees the session, the routes, and a handoff proposal, and can edit, approve, or reject it with ordinary controls.
- **A browser agent** (ChatGPT's browser, or Chrome with WebMCP) reads the same state through seven typed WebMCP tools, proposes a handoff, waits for the human, notices what the human changed, and executes only with a token the approval issued.

Nothing is inferred from the DOM. The page declares what a session, a route, and a handoff mean, and both parties act on the same object.

## What the agent can do

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_session` | read | Task, active model and provider, blocked or running, why, context size, checkpoint. |
| `get_events` | read | The router's event log: requests, 429s, cooldowns, failover attempts, handoff activity. Marked `untrustedContentHint` because summaries relay upstream text. |
| `get_routes` | read | Every route with provider, tier, ready or cooldown, and whether it spends metered usage. |
| `prepare_handoff` | write | Creates a proposal. Refuses cooldown routes and refuses metered routes unless `allow_metered` is true. Never switches anything. |
| `get_handoff` | read | Status, revision, target, every change the human made, and the approval token once approved. |
| `execute_handoff` | write | Resumes the session on the approved route. Fails with `APPROVAL_REQUIRED` before approval and `STALE_APPROVAL` if the human edited after approving. Idempotent. |
| `get_replay` | read | The attributed timeline: runtime, agent, and human actions in order. |

There is deliberately **no approve tool**. Approve and Reject exist only as buttons. Approval issues a token bound to the proposal's revision, and any edit revokes it, so the agent has to come back and read what the human decided.

## Try it in two minutes

1. Open the live URL in the **ChatGPT desktop app's browser**, or in **Chrome 149+** with `chrome://flags/#enable-webmcp-testing` enabled and Chrome relaunched. The pill in the top bar should say "WebMCP: 7 tools registered".
2. Ask the agent:
   > My Airlock coding session looks blocked. Inspect what happened, then get it running again on a route that is ready and does not spend metered usage. Do not change the active model until I approve the handoff in this page.
3. Watch the Agent activity rail. The agent should read the session, events, and routes, then propose a handoff to a ready non-metered route such as GPT-5.6 Sol. If it tries to execute early, the page refuses.
4. In the proposal card, **change the target** to Claude Fable 5.1 (a metered route) and click **Approve**.
5. Tell the agent "continue". It should re-read the proposal, notice your change and that you accepted metered usage, and execute. The session flips to running on Fable from checkpoint `cp_184`, and the Replay shows who did what.

No WebMCP in your browser? Click **Run scripted walkthrough**. It calls the same tool entry point an agent would, pauses at the approval, and finishes after you approve.

## Demo mode and live mode

The hosted page runs in **demo mode**. Its data comes from [fixtures/airlock-diagnostics-2026-09-03.json](fixtures/airlock-diagnostics-2026-09-03.json), an export of the real `GET /diagnostics` report from an Airlock router on 2026-09-03. Events tagged `airlock` were copied verbatim; events tagged `scenario` were added, in the router's exact event shapes, to put the session into the blocked state the demo starts from. The runtime that "resumes" is simulated, and the session card's task, id, checkpoint, and worktree are invented for the demo; only the router data underneath is real. The page labels the origin of every event.

**Live mode** runs against a real Airlock session on your machine:

```bash
npm install && npm run build
python bridge/relay.py --task "what the session is doing"    # inside an Airlock session, or pass --router-url
# open http://127.0.0.1:4783/
```

The bridge is a small standard-library Python program. It serves the same build and a same-origin `relay/api/state` endpoint fed by the router's existing loopback `GET /diagnostics` and `GET /v1/models`. The Airlock router is not modified and stays bound to 127.0.0.1. In live mode the human's Approve click is also recorded by the bridge, which returns a one-shot nonce bound to the proposal, revision, and target. When the agent executes, the page sends that nonce and the bridge runs Airlock's own `airlock handoff set <from> <to>` only if it matches an approval it recorded itself; otherwise it refuses with a reason. The page reports exactly what the bridge did. This keeps the human's decision enforced outside the browser tab, not only inside it. A full orchestrator switch of a running Claude Code process crosses a process boundary that only the launcher can drive, so that part stays with Airlock's launcher and is documented as such.

![Live mode against a real router](docs/screenshot-live-mode.png)

## How WebMCP is used

- Tools are registered once on load with `document.modelContext.registerTool`, each with a JSON Schema, a use-case description, and annotations. Reads carry `readOnlyHint: true`; the event log carries `untrustedContentHint: true`.
- Tool results are bounded (40 events, 60 replay entries) and every error is structured (`code`, `message`, `hint`) so the agent can self-correct instead of guessing.
- The same handlers serve WebMCP, the scripted walkthrough, and the tests, so the agent path is never a special case.
- Human actions and agent actions mutate one store and are both attributed in the replay. The approval token is the concrete mechanism that makes "the human decides" enforceable inside the page, and in live mode the bridge keeps its own approval record so a page script cannot reach the real command on its own.

## Development

```bash
npm install
npm run dev          # Vite dev server
npm test             # 17 Vitest tests on the state machine and tools
npm run typecheck
python -m unittest discover -s bridge -p "test_*.py"   # bridge tests
npm run build && npx vite preview --port 4173
node scripts/webmcp-smoke.mjs http://127.0.0.1:4173/  # drives the tools through Chrome's document.modelContext
```

The smoke test launches Chrome with `--enable-features=WebMCPTesting`, lists the registered tools, and runs the whole flow (metered refusal, early execution refused, human edit and approve in the page, execution, resumed session) through `executeTool`, not through the page's own functions.

## Layout

```
src/runtime/   types, store, Airlock diagnostics adapter, demo builder, live client
src/webmcp/    tool specs and handlers, WebMCP registration, scripted walkthrough
src/ui/        the control room
bridge/        local bridge for live sessions, with tests
fixtures/      the real diagnostics export the demo is built from
scripts/       Chrome smoke test
tests/         Vitest suite
```

## License

MIT. See [LICENSE](LICENSE).
