# Demo video script (target 100 seconds)

Record at 1440x900. Screen: the live URL in a WebMCP-enabled browser. Narration below; on-screen action in brackets.

**0:00**  [Page loaded. Session card shows BLOCKED · rate limit on Claude Opus 5.]
"It's 2 AM. My coding agent has been refactoring an auth layer for three hours, and the Anthropic plan just rate limited. The session is blocked. Normally I'd be reading router logs to work out what's free and how to resume."

**0:12**  [Point at the top bar: WebMCP: 7 tools registered.]
"This is Airlock Relay. The page exposes the runtime through seven WebMCP tools, so a browser agent can do that reading with me instead of guessing from the screen."

**0:22**  [Type the prompt into the agent. Agent activity rail starts filling: get_session, get_events, get_routes.]
"I ask the agent to inspect what happened and get the session running again on a route that's ready and doesn't spend metered usage, without changing anything until I approve."

**0:35**  [prepare_handoff appears. Proposal card shows H-229, Opus → GPT-5.6 Sol, PENDING APPROVAL.]
"It reads the session, the event log, and every route. It proposes GPT-5.6 Sol: ready, frontier tier, not metered. Nothing has switched. It's a proposal."

**0:45**  [execute_handoff → APPROVAL_REQUIRED in the rail.]
"When it tries to execute early, the page refuses. There is no approve tool. Approval is a button, and only I have it."

**0:53**  [Change the To dropdown to Claude Fable 5.1 (metered). Click Approve. Human changes list updates.]
"I'd rather stay on Claude. I change the target to Fable, which is metered, and approve. That issues a token bound to this exact revision. If I edit again, it's revoked."

**1:05**  [Tell the agent "continue". get_handoff, then execute_handoff → resumed. Session card flips to RUNNING on Claude Fable 5.1.]
"The agent re-reads the proposal, sees my change and that I accepted metered usage, and executes. The session resumes from its checkpoint."

**1:16**  [Scroll the Replay: RUNTIME, AGENT, RELAY, HUMAN rows in order.]
"The replay shows who did what: the runtime, the agent, and me, on one shared object."

**1:24**  [Cut to live mode screenshot or window: LIVE Airlock session pill, real events.]
"The demo is seeded from a real Airlock router report. The same page runs live against a real session through a small loopback bridge."

**1:33**  [Back to the page.]
"WebMCP turns a runtime a person had to babysit into a workspace a person and an agent can operate together. Airlock Relay."

**1:40**  End card: URL and repo.
