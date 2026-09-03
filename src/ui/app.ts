// Renders the control room from RelayState. The human's controls call the
// store's human* methods; nothing here is reachable by the agent.

import type { RelayStore } from "../runtime/state";
import type { Handoff, RelayState, ReplayEntry, Route, Scenario } from "../runtime/types";
import { SCENARIOS } from "../runtime/demo";

export interface UiContext {
  store: RelayStore;
  webmcp: { available: boolean; registered: string[]; errors: string[] } | null;
  onReset: () => void;
  onScenario: (scenario: Scenario) => void;
  onResume: () => void;
  onWalkthrough: () => void;
  walkthroughRunning: boolean;
}

const SUGGESTED_PROMPT =
  "My Airlock coding session looks blocked. Inspect what happened, then get it running again on a route that is ready and does not spend metered usage. Do not change the active model until I approve the handoff in this page.";

const TOOL_NAMES = ["get_session", "get_events", "get_routes", "prepare_handoff", "get_handoff", "execute_handoff", "get_replay"];

const PROVIDER_LABEL: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI", grok: "xAI", openrouter: "OpenRouter" };

const ACTOR_LABEL: Record<ReplayEntry["actor"], string> = { runtime: "Runtime", agent: "Agent", human: "You", relay: "Relay" };

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

function hhmmss(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  return d.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function short(model: string): string {
  return model.replace(/\[1m\]$/, "");
}

function label(state: RelayState, id: string): string {
  return state.routes.find((r) => r.id === id)?.label ?? short(id);
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function countdown(iso?: string): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "now";
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function clock(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function activeRoute(state: RelayState): Route | undefined {
  return state.routes.find((r) => short(r.id) === short(state.session.activeModel));
}

// ---- Header -----------------------------------------------------------------

function renderHeader(ctx: UiContext, state: RelayState): string {
  const w = ctx.webmcp;
  const webmcp = !w
    ? `<span class="pill">Checking WebMCP…</span>`
    : w.available
      ? `<span class="pill ok" title="${esc(w.registered.join(", "))}"><i class="dot"></i>WebMCP · ${w.registered.length} tools</span>`
      : `<span class="pill warn"><i class="dot"></i>WebMCP not detected</span>`;
  const mode =
    state.mode === "live"
      ? `<span class="pill live"><i class="dot"></i>Live session</span>`
      : `<span class="pill demo" title="Seeded from a real Airlock router export. Nothing here is a real outage."><i class="dot"></i>Demo</span>`;
  const scenario =
    state.mode === "demo"
      ? `<label class="select-wrap"><span class="sr-only">Demo scenario</span><select data-action="scenario" aria-label="Demo scenario">${SCENARIOS.map((s) => `<option value="${s.id}" ${s.id === state.scenario ? "selected" : ""}>${esc(s.title)}</option>`).join("")}</select></label>`
      : "";
  return `
    <header class="top">
      <div class="brand">
        <span class="mark" aria-hidden="true"></span>
        <div>
          <div class="wordmark">Airlock Relay</div>
          <div class="tagline">One stuck coding session. A person and a browser agent fix it together.</div>
        </div>
      </div>
      <div class="top-actions">
        ${mode}
        ${webmcp}
        ${scenario}
        <button class="btn ghost" data-action="walkthrough" ${ctx.walkthroughRunning ? "disabled" : ""}>${ctx.walkthroughRunning ? "Walkthrough running…" : "Scripted walkthrough"}</button>
        <button class="btn ghost" data-action="reset">Reset</button>
      </div>
    </header>`;
}

// ---- Hero: status and hand-off prompt ------------------------------------------

function heroCopy(state: RelayState): { title: string; sub: string } {
  const s = state.session;
  const active = activeRoute(state);
  if (s.status === "running") {
    const h = state.handoff;
    if (h?.status === "executed" && h.result) {
      return { title: `Running on ${label(state, h.result.active)}.`, sub: `Handed off from ${label(state, h.result.previous)} and resumed at checkpoint ${h.result.checkpoint}. Nothing was lost.` };
    }
    return { title: `Running on ${active?.label ?? short(s.activeModel)}.`, sub: `Making requests on ${PROVIDER_LABEL[s.activeProvider] ?? s.activeProvider}. A proposal appears here if it stalls.` };
  }
  if (s.blockedReason === "context_overflow") {
    const room = state.routes.filter((r) => r.contextWindow >= s.contextTokens && short(r.id) !== short(s.activeModel)).length;
    return { title: `Context overflow on ${active?.label ?? short(s.activeModel)}.`, sub: `${fmtTokens(s.contextTokens)} tokens do not fit the ${fmtTokens(active?.contextWindow ?? 0)} window. ${room} of ${state.routes.length} routes have room.` };
  }
  const cooling = state.routes.filter((r) => r.status === "cooldown");
  const head = active?.headroom;
  const reset = cooling.find((r) => r.cooldownUntil)?.cooldownUntil;
  const usage = head ? `The ${head.window} plan window is ${head.usedPercent}% used` : "The plan window is exhausted";
  return {
    title: `Rate limit on ${PROVIDER_LABEL[s.activeProvider] ?? s.activeProvider}.`,
    sub: `${usage}${reset ? ` and resets in ${countdown(reset)}` : ""}. ${cooling.length} of ${state.routes.length} routes are on cooldown.`,
  };
}

function renderHero(ctx: UiContext, state: RelayState): string {
  const s = state.session;
  const active = activeRoute(state);
  const { title, sub } = heroCopy(state);
  const pct = active ? Math.min(100, Math.round((s.contextTokens / active.contextWindow) * 100)) : 0;
  const w = ctx.webmcp;
  let aside = "";
  if (w && !w.available) {
    aside = `
      <div class="banner warn" role="status">
        <strong>WebMCP is not available in this browser.</strong>
        <p>Open this page in the ChatGPT desktop app's browser, or in Chrome 149+ with <code>chrome://flags/#enable-webmcp-testing</code> enabled. The scripted walkthrough shows the same flow without an agent.</p>
      </div>`;
  } else if (s.status === "blocked" && !state.handoff) {
    aside = `
      <div class="banner ok" role="status">
        <strong>Hand it to your agent</strong>
        <p class="lead">Seven tools are registered on this page. Paste this into your browser agent:</p>
        <div class="prompt-box"><p id="suggested-prompt">${esc(SUGGESTED_PROMPT)}</p><button class="btn small" data-action="copy-prompt">Copy</button></div>
      </div>`;
  }
  return `
    <section class="hero ${s.status}">
      <div class="hero-main">
        <span class="status ${s.status}"><i class="dot"></i>${s.status === "blocked" ? "Blocked" : s.status === "running" ? "Running" : "Resuming"}</span>
        <h1>${esc(title)}</h1>
        <p class="sub">${esc(sub)}</p>
        <dl class="facts">
          <div><dt>Task</dt><dd>${esc(s.task)}</dd></div>
          <div><dt>Active model</dt><dd>${esc(active?.label ?? short(s.activeModel))} <span class="mono dim">${esc(short(s.activeModel))}</span></dd></div>
          <div><dt>Context</dt><dd>${fmtTokens(s.contextTokens)} of ${fmtTokens(active?.contextWindow ?? 0)}<span class="meter" aria-hidden="true"><i style="width:${pct}%"></i></span></dd></div>
          <div><dt>Checkpoint</dt><dd class="mono">${esc(s.checkpoint)}</dd></div>
          <div><dt>Worktree</dt><dd class="mono">${esc(s.workdir)}</dd></div>
          <div><dt>${state.mode === "live" && state.bridge?.sessionId ? "Claude session" : "Session"}</dt><dd class="mono">${esc(state.mode === "live" && state.bridge?.sessionId ? state.bridge.sessionId.slice(0, 8) : s.id)} · ${esc(s.profile)}</dd></div>
        </dl>
      </div>
      ${aside ? `<div class="hero-aside">${aside}</div>` : ""}
    </section>`;
}

// ---- Proposal -------------------------------------------------------------------

function renderProposal(state: RelayState): string {
  const h = state.handoff;
  if (!h) {
    return `
      <section class="card handoff" aria-labelledby="handoff-h">
        <header><h2 id="handoff-h">Handoff proposal</h2><span class="hint">nothing proposed yet</span></header>
        <div class="steps">
          <div class="step"><span class="n">1</span><div><b>The agent reads.</b> get_session, get_events and get_routes tell it what broke and what is still available.</div></div>
          <div class="step"><span class="n">2</span><div><b>The agent proposes.</b> prepare_handoff writes a proposal here. Cooldown routes, routes without room, and metered routes it was not allowed are refused.</div></div>
          <div class="step"><span class="n">3</span><div><b>You decide.</b> Change the target, add a note, then approve or reject. Approval is bound to the revision you saw.</div></div>
          <div class="step"><span class="n">4</span><div><b>The agent executes.</b> execute_handoff resumes the work from its checkpoint, or is refused if you edited after approving.</div></div>
        </div>
      </section>`;
  }
  const editable = h.status === "pending_approval" || h.status === "approved";
  const target = state.routes.find((r) => r.id === h.target);
  const options = state.routes
    .filter((r) => r.status === "ready" && short(r.id) !== short(h.from) && r.contextWindow >= state.session.contextTokens)
    .map((r) => `<option value="${esc(r.id)}" ${r.id === h.target ? "selected" : ""}>${esc(r.label)} · ${esc(PROVIDER_LABEL[r.provider] ?? r.provider)}${r.metered ? " · metered" : ""}</option>`)
    .join("");
  const changes = h.humanChanges.length
    ? `<div class="block"><h3>What you changed</h3><ul class="changes">${h.humanChanges
        .map((c) => {
          const what =
            c.field === "target"
              ? `changed the target to <b>${esc(label(state, String(c.to)))}</b> <span class="dim">was ${esc(label(state, String(c.from)))}</span>`
              : c.field === "approval"
                ? `<b>approved</b> revision ${c.revision}`
                : c.field === "rejection"
                  ? `<b>rejected</b> the proposal`
                  : c.field === "note"
                    ? `added a note`
                    : `set ${esc(JSON.stringify(c.to))}`;
          return `<li><time>${hhmmss(c.at)}</time><span>${what}${c.note ? `<span class="note-warn">${esc(c.note)}</span>` : ""}</span></li>`;
        })
        .join("")}</ul></div>`
    : "";
  const preserve = (["checkpoint", "worktree", "task"] as const)
    .map((k) => `<label class="check"><input type="checkbox" data-preserve="${k}" ${h.preserve[k] ? "checked" : ""} ${editable ? "" : "disabled"}><span>keep ${k}</span></label>`)
    .join("");
  let outcome = "";
  if (h.status === "executed" && h.result) {
    outcome = `<div class="outcome ok"><b>Executed.</b> The session resumed on ${esc(label(state, h.result.active))} from checkpoint <span class="mono">${esc(h.result.checkpoint)}</span>, leaving ${esc(label(state, h.result.previous))} behind.</div>`;
    if (state.mode === "live") {
      outcome += `
        <div class="resume">
          <button class="btn primary" data-action="resume">Resume in a new terminal</button>
          <p class="hint">Exit the blocked session first. This relaunches the same conversation on the approved model.</p>
          ${state.bridge?.resumeCommand ? `<code class="cmd">${esc(state.bridge.resumeCommand)}</code>` : ""}
          ${state.bridge?.resumeStatus ? `<p class="hint">${esc(state.bridge.resumeStatus)}</p>` : ""}
        </div>`;
    }
  } else if (h.status === "rejected") {
    outcome = `<div class="outcome muted">Rejected. The agent sees this on its next get_handoff call.</div>`;
  } else if (h.status === "superseded") {
    outcome = `<div class="outcome muted">Superseded by a newer proposal.</div>`;
  } else {
    outcome = `
      <div class="actions">
        <button class="btn primary" data-action="approve" ${h.status === "approved" ? "disabled" : ""}>${h.status === "approved" ? "Approved · waiting for the agent" : "Approve handoff"}</button>
        <button class="btn ghost" data-action="reject">Reject</button>
        <span class="hint">${h.status === "approved" ? `Token issued for revision ${h.revision}. Any edit revokes it.` : "Approval issues a token bound to this revision."}</span>
      </div>`;
  }
  return `
    <section class="card handoff" aria-labelledby="handoff-h">
      <header>
        <h2 id="handoff-h">Handoff proposal</h2>
        <span class="meta"><span class="mono">${esc(h.id)}</span> · rev ${h.revision} · proposed by ${h.createdBy === "agent" ? "the agent" : "you"}</span>
        <span class="hstatus ${h.status}">${h.status.replace("_", " ")}</span>
      </header>
      <div class="fromto">
        <div class="box from"><span class="k">From</span><div class="model">${esc(label(state, h.from))}</div><div class="mono dim">${esc(short(h.from))} · ${esc(PROVIDER_LABEL[state.routes.find((r) => r.id === h.from)?.provider ?? ""] ?? "")}</div></div>
        <span class="arrow" aria-hidden="true">→</span>
        <div class="box to ${editable ? "editable" : ""}">
          <span class="k">To${editable ? " · yours to change" : ""}</span>
          ${editable ? `<label class="select-wrap big"><span class="sr-only">Handoff target</span><select data-action="target" aria-label="Handoff target">${options}</select></label>` : `<div class="model">${esc(target?.label ?? short(h.target))}</div>`}
          <div class="mono dim">${esc(short(h.target))}${target?.metered ? ' · <span class="metered">metered</span>' : ""}</div>
        </div>
      </div>
      ${target?.metered ? `<p class="warn-line">This target spends metered usage. Approving it overrides the proposal's <span class="mono">allow_metered=false</span>.</p>` : ""}
      <blockquote class="reason"><span class="k agent">Agent's reason</span>${esc(h.reason)}</blockquote>
      <div class="row">
        <div class="block"><h3>Preserve</h3><div class="checks">${preserve}</div></div>
        <div class="block grow"><h3>Note for the record</h3><input class="input" data-action="note" placeholder="Optional, press Enter to save" value="${esc(h.note)}" ${editable ? "" : "disabled"} aria-label="Note for the record" /></div>
      </div>
      ${changes}
      ${outcome}
    </section>`;
}

// ---- Timeline (replay) ------------------------------------------------------------

function renderTimeline(state: RelayState): string {
  const entries = state.replay.slice(-40);
  const body = entries
    .map(
      (e) => `<li class="${e.actor}"><time>${hhmmss(e.at)}</time><span class="actor"><i class="dot"></i>${ACTOR_LABEL[e.actor]}</span><span class="what"><b>${esc(e.action)}</b>${e.detail ? ` <span class="dim">${esc(e.detail)}</span>` : ""}</span></li>`,
    )
    .join("");
  return `
    <section class="card timeline" aria-labelledby="replay-h">
      <header><h2 id="replay-h">Timeline</h2><span class="hint">who did what, in order · ${state.replay.length} entries</span></header>
      <ul class="replay">${body}</ul>
    </section>`;
}

// ---- Routes ----------------------------------------------------------------------

function renderRoutes(state: RelayState): string {
  const s = state.session;
  const items = state.routes
    .map((r) => {
      const isActive = short(r.id) === short(s.activeModel);
      const fits = r.contextWindow >= s.contextTokens;
      const left = r.status === "cooldown" ? countdown(r.cooldownUntil) : "";
      const head = r.headroom;
      return `
        <li class="${r.status}${isActive ? " active" : ""}${fits ? "" : " noroom"}">
          <div class="r-main">
            <div class="r-name">${esc(r.label)}${isActive ? '<span class="chip active">active</span>' : ""}${r.metered ? '<span class="chip metered">metered</span>' : ""}</div>
            <div class="r-meta">${esc(PROVIDER_LABEL[r.provider] ?? r.provider)} · ${esc(r.tier)} · ${fmtTokens(r.contextWindow)} window · ${fits ? '<span class="fit">fits</span>' : '<span class="nofit">no room</span>'}</div>
            ${head ? `<div class="r-head"><span class="bar" aria-hidden="true"><i style="width:${head.usedPercent}%" class="${head.usedPercent >= 90 ? "hot" : ""}"></i></span><span>${head.usedPercent}% of ${esc(head.window)} used${head.usedPercent >= 90 && head.resetsAt ? ` · resets ${clock(head.resetsAt)}` : ""}</span></div>` : ""}
          </div>
          <div class="r-state"><span class="state">${r.status}</span>${left ? `<span class="left">${left}</span>` : ""}</div>
        </li>`;
    })
    .join("");
  const ready = state.routes.filter((r) => r.status === "ready").length;
  const noRoom = state.routes.filter((r) => r.contextWindow < s.contextTokens).length;
  return `
    <section class="card" aria-labelledby="routes-h">
      <header><h2 id="routes-h">Routes</h2><span class="hint">${ready} of ${state.routes.length} ready${noRoom ? ` · ${noRoom} without room` : ""}</span></header>
      <ul class="routes">${items}</ul>
    </section>`;
}

// ---- Agent activity and router events ------------------------------------------------

function renderActivity(state: RelayState): string {
  const calls = state.agentCalls.slice(-30);
  const body = calls.length
    ? calls.map((c) => `<li class="${c.ok ? "" : "err"}"><time>${hhmmss(c.at)}</time><span class="tool">${esc(c.tool)}</span><span class="sum">${esc(c.summary)}</span><span class="ms">${c.durationMs}ms</span></li>`).join("")
    : `<li class="empty"><span>No tool calls yet. Registered on this page:</span><span class="tools">${TOOL_NAMES.map((t) => `<code>${t}</code>`).join("")}</span></li>`;
  return `
    <section class="card" aria-labelledby="activity-h">
      <header><h2 id="activity-h"><i class="dot agent"></i>Agent activity</h2><span class="hint">${state.agentCalls.length} calls</span></header>
      <ul class="log activity" id="activity-log" aria-live="polite">${body}</ul>
    </section>`;
}

function renderEvents(state: RelayState): string {
  const events = state.events.slice(-40);
  const body = events
    .map((e) => `<li class="${e.source === "relay" ? "relay" : ""}"><time>${hhmmss(e.at)}</time><span class="src ${esc(e.source)}">${esc(e.source)}</span><span class="sum"><span class="kind">${esc(e.kind)}</span> ${esc(e.summary)}</span></li>`)
    .join("");
  return `
    <section class="card" aria-labelledby="events-h">
      <header><h2 id="events-h"><i class="dot runtime"></i>Runtime events</h2><span class="hint">${state.events.length} · real events are tagged airlock, seeded ones scenario</span></header>
      <ul class="log events" id="events-log">${body}</ul>
    </section>`;
}

// ---- Page ---------------------------------------------------------------------------

export function render(root: HTMLElement, ctx: UiContext): void {
  const state = ctx.store.get();
  const activeEl = document.activeElement as HTMLElement | null;
  const keepFocus = activeEl?.dataset?.action === "note" ? (activeEl as HTMLInputElement).value : null;
  root.innerHTML = `
    ${renderHeader(ctx, state)}
    ${renderHero(ctx, state)}
    <main class="grid">
      <div class="col main">
        ${renderProposal(state)}
        ${renderTimeline(state)}
      </div>
      <div class="col side">
        ${renderActivity(state)}
        ${renderRoutes(state)}
        ${renderEvents(state)}
      </div>
    </main>
    <footer>
      <span class="legend"><i class="dot runtime"></i>Runtime <i class="dot agent"></i>Agent <i class="dot human"></i>You <i class="dot relay"></i>Relay</span>
      <span>Approve and Reject exist only as buttons. There is deliberately no WebMCP tool for them.</span>
      <span><a href="https://github.com/Harshkamdar67/Airlock" target="_blank" rel="noopener">Airlock</a> · <a href="https://github.com/Harshkamdar67/airlock-relay" target="_blank" rel="noopener">Source</a></span>
    </footer>`;
  if (keepFocus !== null) {
    const note = root.querySelector<HTMLInputElement>('input[data-action="note"]');
    if (note) {
      note.value = keepFocus;
      note.focus();
    }
  }
  for (const log of root.querySelectorAll<HTMLElement>(".log, .replay")) log.scrollTop = log.scrollHeight;
}

export function bind(root: HTMLElement, ctx: UiContext): void {
  root.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!target || target.tagName === "SELECT" || target.tagName === "INPUT") return;
    const action = target.dataset.action;
    if (action === "approve") ctx.store.humanApprove();
    else if (action === "reject") ctx.store.humanReject();
    else if (action === "reset") ctx.onReset();
    else if (action === "resume") ctx.onResume();
    else if (action === "walkthrough") ctx.onWalkthrough();
    else if (action === "copy-prompt") {
      void navigator.clipboard?.writeText(SUGGESTED_PROMPT);
      target.textContent = "Copied";
      setTimeout(() => (target.textContent = "Copy"), 1200);
    }
  });
  root.addEventListener("change", (event) => {
    const el = event.target as HTMLElement;
    if (el.matches('select[data-action="target"]')) ctx.store.humanSetTarget((el as HTMLSelectElement).value);
    else if (el.matches('select[data-action="scenario"]')) ctx.onScenario((el as HTMLSelectElement).value as Scenario);
    else if (el.matches("input[data-preserve]")) ctx.store.humanSetPreserve(el.dataset.preserve as keyof Handoff["preserve"], (el as HTMLInputElement).checked);
  });
  root.addEventListener("keydown", (event) => {
    const el = event.target as HTMLElement;
    if (event.key === "Enter" && el.matches('input[data-action="note"]')) {
      ctx.store.humanSetNote((el as HTMLInputElement).value);
      (el as HTMLInputElement).blur();
    }
  });
  root.addEventListener(
    "blur",
    (event) => {
      const el = event.target as HTMLElement;
      if (el.matches?.('input[data-action="note"]')) {
        const value = (el as HTMLInputElement).value;
        if (value !== ctx.store.get().handoff?.note) ctx.store.humanSetNote(value);
      }
    },
    true,
  );
}

export { SUGGESTED_PROMPT };
