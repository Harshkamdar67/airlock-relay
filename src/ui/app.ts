// Renders the control room from RelayState. The human's controls call the
// store's human* methods; nothing here is reachable by the agent.
//
// Four actors appear on this page and each keeps one colour and one glyph
// everywhere it shows up, so attribution is readable at a glance:
//   runtime ▣ blue   agent ◆ mint   human ◉ violet   relay ◈ amber

import type { RelayStore } from "../runtime/state";
import type { Actor, EventSource, Handoff, Provider, RelayState, Route, Scenario } from "../runtime/types";
import { SCENARIOS } from "../runtime/demo";

export interface UiContext {
  store: RelayStore;
  webmcp: { available: boolean; registered: string[]; errors: string[] } | null;
  onReset: () => void;
  onScenario: (scenario: Scenario) => void;
  onWalkthrough: () => void;
  /** Live mode only: relaunch the conversation on the approved route. */
  onResume: () => void;
  walkthroughRunning: boolean;
}

const SUGGESTED_PROMPT =
  "My Airlock coding session looks blocked. Inspect what happened, then get it running again on a route that is ready and does not spend metered usage. Do not change the active model until I approve the handoff in this page.";

const PROVIDER_LABEL: Record<Provider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  grok: "xAI",
  openrouter: "OpenRouter",
};

const ACTOR_GLYPH: Record<Actor, string> = { runtime: "▣", agent: "◆", human: "◉", relay: "◈" };

const SOURCE_GLYPH: Record<EventSource, string> = {
  airlock: "▣",
  scenario: "▢",
  relay: "◈",
  "claude-code": "▣",
  generic: "▣",
};

const SOURCE_TITLE: Record<EventSource, string> = {
  airlock: "Copied verbatim from a real Airlock router report",
  scenario: "Seeded for this demo, in the router's own event shape",
  relay: "Produced by this page",
  "claude-code": "Ingested from a live Claude Code session through the bridge",
  generic: "Ingested from another runtime through the bridge",
};

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

function hhmmss(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  return d.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--";
  return d.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit" });
}

function short(model: string): string {
  return model.replace(/\[1m\]$/, "");
}

function label(state: RelayState, id: string): string {
  return state.routes.find((r) => r.id === id)?.label ?? short(id);
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}

/** Live countdown. The store re-emits every 5s, so this refreshes on render. */
function countdown(iso?: string): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "any moment";
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function activeRoute(state: RelayState): Route | undefined {
  return state.routes.find((r) => short(r.id) === short(state.session.activeModel));
}

function fitsSession(state: RelayState, r: Route): boolean {
  return r.contextWindow >= state.session.contextTokens;
}

/* ---------------------------------------------------------------- top bar */

function renderTopbar(ctx: UiContext, state: RelayState): string {
  const w = ctx.webmcp;
  const webmcpPill = !w
    ? `<span class="pill">checking WebMCP…</span>`
    : w.available
      ? `<span class="pill ok" title="${esc(w.registered.join(", "))}"><span class="blink"></span> WebMCP: ${w.registered.length} tools registered</span>`
      : `<span class="pill warn"><span class="pill-glyph" aria-hidden="true">!</span> WebMCP not detected</span>`;
  const mode =
    state.mode === "live"
      ? `<span class="pill live"><span class="blink"></span> LIVE Airlock session</span>`
      : `<span class="pill" title="Built from a real Airlock router diagnostics export">DEMO session</span>`;
  const scenario = SCENARIOS.find((s) => s.id === state.scenario);
  const scenarioPicker =
    state.mode === "demo"
      ? `<label class="field" title="${esc(scenario?.blurb ?? "")}">
           <span class="field-label">Scenario</span>
           <select data-action="scenario">${SCENARIOS.map((s) => `<option value="${s.id}" ${s.id === state.scenario ? "selected" : ""}>${esc(s.title)}</option>`).join("")}</select>
         </label>`
      : "";
  return `
    <header class="topbar">
      <div class="brand">
        <span class="mark" aria-hidden="true"><span class="mark-core"></span></span>
        <span class="brand-text">
          <span class="wordmark">AIRLOCK RELAY</span>
          <span class="tagline">One stuck coding session, supervised by a human and a browser agent at the same time.</span>
        </span>
      </div>
      <div class="spacer"></div>
      <div class="pills">${mode}${webmcpPill}</div>
      <div class="controls">
        <button class="btn ghost" data-action="walkthrough" ${ctx.walkthroughRunning ? "disabled" : ""}>${ctx.walkthroughRunning ? "Walkthrough running…" : "Run scripted walkthrough"}</button>
        <div class="segment">
          ${scenarioPicker}
          <button class="btn" data-action="reset">Reset</button>
        </div>
      </div>
    </header>`;
}

/* ------------------------------------------------------------ status band */

function renderStatusBand(state: RelayState): string {
  const s = state.session;
  const active = activeRoute(state);
  const pct = active ? Math.min(100, Math.round((s.contextTokens / active.contextWindow) * 100)) : 0;
  const cooling = state.routes.filter((r) => r.status === "cooldown").length;
  const fitting = state.routes.filter((r) => fitsSession(state, r) && r.status === "ready").length;
  const h = state.handoff;

  let headline: string;
  let detail: string;
  if (s.status === "blocked" && s.blockedReason === "rate_limit") {
    const hr = active?.headroom;
    headline = `Rate limit on ${PROVIDER_LABEL[s.activeProvider]}`;
    detail = hr
      ? `The ${esc(hr.window)} plan window is ${Math.round(hr.usedPercent)}% used and resets in ${countdown(hr.resetsAt)}. ${cooling} of ${state.routes.length} routes are on cooldown.`
      : `${cooling} of ${state.routes.length} routes are on cooldown.`;
  } else if (s.status === "blocked" && s.blockedReason === "context_overflow") {
    headline = `Context overflow on ${esc(active?.label ?? short(s.activeModel))}`;
    detail = `${fmtTokens(s.contextTokens)} tokens do not fit the ${fmtTokens(active?.contextWindow ?? 0)} window. Only ${fitting} ready ${fitting === 1 ? "route has" : "routes have"} room for this session.`;
  } else if (s.status === "blocked") {
    headline = "Blocked by a provider error";
    detail = "The router could not retry past the last upstream failure.";
  } else if (s.status === "resuming") {
    headline = `Resuming on ${esc(active?.label ?? short(s.activeModel))}`;
    detail = `Restoring checkpoint ${esc(s.checkpoint)}.`;
  } else {
    headline = `Running on ${esc(active?.label ?? short(s.activeModel))}`;
    detail =
      h?.status === "executed" && h.result
        ? `Handed off from ${esc(label(state, h.result.previous))} and resumed at checkpoint ${esc(h.result.checkpoint)}. No work was lost.`
        : `The session is making requests on ${esc(PROVIDER_LABEL[s.activeProvider])}.`;
  }

  return `
    <section class="statusband" aria-label="Session status">
      <div class="status ${s.status}">
        <span class="beacon" aria-hidden="true"></span>
        <span class="word">${esc(s.status.toUpperCase())}</span>
      </div>
      <div class="status-copy">
        <h1>${headline}</h1>
        <p>${detail}</p>
      </div>
      <dl class="status-stats">
        <div class="stat">
          <dt>Active model</dt>
          <dd>${esc(active?.label ?? short(s.activeModel))}<span class="sub mono">${esc(short(s.activeModel))}</span></dd>
        </div>
        <div class="stat">
          <dt>Context used</dt>
          <dd><span class="mono">${fmtTokens(s.contextTokens)}${active ? ` / ${fmtTokens(active.contextWindow)}` : ""}</span><span class="meter ${pct >= 95 ? "full" : pct >= 70 ? "high" : ""}"><i style="width:${Math.max(2, pct)}%"></i></span></dd>
        </div>
        <div class="stat">
          <dt>Checkpoint</dt>
          <dd class="mono">${esc(s.checkpoint)}<span class="sub">${esc(s.id)}</span></dd>
        </div>
      </dl>
    </section>`;
}

/* ----------------------------------------------------------------- banner */

function renderBanner(ctx: UiContext, state: RelayState): string {
  const w = ctx.webmcp;
  if (w && !w.available) {
    return `
      <div class="banner" role="status">
        <span class="banner-glyph" aria-hidden="true">!</span>
        <div>WebMCP is not available in this browser. Open this page in the ChatGPT desktop app's browser, or in Chrome 149+ with <code>chrome://flags/#enable-webmcp-testing</code> enabled. The scripted walkthrough shows the same flow without an agent.</div>
      </div>`;
  }
  if (state.handoff || state.session.status !== "blocked") return "";
  return `
    <div class="banner ok" role="status">
      <span class="banner-glyph agent" aria-hidden="true">◆</span>
      <div class="prompt">
        <div class="prompt-lead">Seven tools are registered. Hand this page to your browser agent: it can read the session, the router events and the routes, then propose a move for you to approve.</div>
        <div class="prompt-box">
          <p id="suggested-prompt">${esc(SUGGESTED_PROMPT)}</p>
          <button class="btn small" data-action="copy-prompt">Copy prompt</button>
        </div>
      </div>
    </div>`;
}

/* ---------------------------------------------------------------- session */

function renderSession(state: RelayState): string {
  const s = state.session;
  const bridgeSession =
    state.mode === "live" && state.bridge?.sessionId
      ? `<dt>Claude session</dt><dd class="mono" title="${esc(state.bridge.sessionId)}">${esc(state.bridge.sessionId.slice(0, 8))}</dd>`
      : "";
  return `
    <section class="card session" aria-labelledby="session-h">
      <header id="session-h">Session <span class="count mono">${esc(s.id)}</span></header>
      <div class="body">
        <p class="task">${esc(s.task)}</p>
        <dl class="kv">
          <dt>Worktree</dt><dd class="mono">${esc(s.workdir)}</dd>
          <dt>Profile</dt><dd class="mono">${esc(s.profile)}</dd>
          ${bridgeSession}
          <dt>Started</dt><dd class="mono">${hhmmss(s.startedAt)}</dd>
        </dl>
      </div>
    </section>`;
}

/* ----------------------------------------------------------------- routes */

function renderHeadroom(r: Route): string {
  const h = r.headroom;
  if (!h) return "";
  const pct = Math.max(0, Math.min(100, Math.round(h.usedPercent)));
  const level = pct >= 95 ? "full" : pct >= 70 ? "high" : "ok";
  const resets = h.window === "credits" ? "pay as you go" : `resets ${hhmm(h.resetsAt)}`;
  return `
    <div class="headroom" title="${esc(PROVIDER_LABEL[r.provider])} plan usage: ${pct}% of the ${esc(h.window)} window">
      <span class="hr-bar ${level}"><i style="width:${Math.max(2, pct)}%"></i></span>
      <span class="hr-text"><b>${pct}%</b> of ${esc(h.window)} plan used<span class="sep">·</span>${esc(resets)}</span>
    </div>`;
}

function renderRoutes(state: RelayState): string {
  const activeId = short(state.session.activeModel);
  const ready = state.routes.filter((r) => r.status === "ready").length;
  const noRoom = state.routes.filter((r) => !fitsSession(state, r)).length;
  const items = state.routes
    .map((r: Route) => {
      const isActive = short(r.id) === activeId;
      const fits = fitsSession(state, r);
      const left = countdown(r.cooldownUntil);
      const word = r.status === "cooldown" ? "COOLDOWN" : r.status === "ready" ? "READY" : "OFF";
      return `
        <li class="${r.status}${isActive ? " active" : ""}${fits ? "" : " nofit"}">
          <div class="r-head">
            <span class="r-name">${esc(r.label)}</span>
            <span class="r-state">${word}${left ? `<em class="mono">${esc(left)}</em>` : ""}</span>
          </div>
          <div class="r-meta">
            <span>${esc(PROVIDER_LABEL[r.provider])}</span><span class="sep">·</span><span>${esc(r.tier)}</span><span class="sep">·</span><span class="mono">${fmtTokens(r.contextWindow)} ctx</span>
            <span class="fit ${fits ? "yes" : "no"}" title="${fits ? `Fits this session's ${fmtTokens(state.session.contextTokens)} tokens` : `Too small for this session's ${fmtTokens(state.session.contextTokens)} tokens`}">${fits ? "✓ fits" : "✕ no room"}</span>
            ${r.metered ? `<span class="tag metered" title="Spends metered usage beyond the plan">$ metered</span>` : ""}
            ${isActive ? `<span class="tag active">● active</span>` : ""}
          </div>
          ${renderHeadroom(r)}
        </li>`;
    })
    .join("");
  return `
    <section class="card routes-card" aria-labelledby="routes-h">
      <header id="routes-h">Routes <span class="count">${ready} ready of ${state.routes.length}${noRoom ? ` · <span class="no-room">${noRoom} no room</span>` : ""}</span></header>
      <ul class="routes">${items}</ul>
    </section>`;
}

/* ---------------------------------------------------------------- handoff */

function renderHandoff(state: RelayState): string {
  const h = state.handoff;
  if (!h) {
    const blocked = state.session.status === "blocked";
    return `
      <section class="card handoff" aria-labelledby="handoff-h">
        <header id="handoff-h">Handoff proposal</header>
        <div class="body">
          <div class="empty">
            <span class="empty-mark" aria-hidden="true">◆</span>
            <h3>${blocked ? "Waiting for a proposal" : "Nothing to hand off"}</h3>
            <p>${
              blocked
                ? "The session is blocked. An agent reads it through WebMCP and proposes a move here. Nothing switches until you approve it in this card."
                : "The session is running. A proposal appears here if it stalls again."
            }</p>
            <ol class="steps">
              <li><span class="who agent" aria-hidden="true">◆</span><b>The agent reads</b><span>get_session, get_events and get_routes tell it what broke and what is still available.</span></li>
              <li><span class="who agent" aria-hidden="true">◆</span><b>The agent proposes</b><span>prepare_handoff writes a proposal into this card. It refuses cooldown routes and metered routes it was not allowed.</span></li>
              <li><span class="who human" aria-hidden="true">◉</span><b>You decide</b><span>Change the target, add a note, then Approve or Reject. Approval is bound to the revision you saw.</span></li>
              <li><span class="who agent" aria-hidden="true">◆</span><b>The agent executes</b><span>execute_handoff resumes the work from its checkpoint, or is refused if you edited it after approving.</span></li>
            </ol>
          </div>
        </div>
      </section>`;
  }
  const editable = h.status === "pending_approval" || h.status === "approved";
  const target = state.routes.find((r) => r.id === h.target);
  const fromRoute = state.routes.find((r) => r.id === h.from);
  // The store refuses a target whose window cannot hold the session, so only
  // ready routes with room are offered here.
  const selectable = state.routes.filter(
    (r) => r.status === "ready" && short(r.id) !== short(h.from) && (fitsSession(state, r) || r.id === h.target),
  );
  const options = selectable
    .map(
      (r) =>
        `<option value="${esc(r.id)}" ${r.id === h.target ? "selected" : ""}>${esc(r.label)} · ${esc(PROVIDER_LABEL[r.provider])}${r.metered ? " · metered" : ""}</option>`,
    )
    .join("");

  const changes = h.humanChanges.length
    ? `<div class="changes-wrap">
         <div class="section-label"><span class="who human" aria-hidden="true">◉</span> What the human changed</div>
         <ul class="changes">${h.humanChanges
           .map((c) => {
             const what =
               c.field === "target"
                 ? `changed the target to <b>${esc(label(state, String(c.to)))}</b> <span class="was">was ${esc(label(state, String(c.from)))}</span>`
                 : c.field === "approval"
                   ? `<b>approved</b> revision ${c.revision}`
                   : c.field === "rejection"
                     ? `<b>rejected</b> the proposal`
                     : c.field === "note"
                       ? `added a note`
                       : `set ${esc(JSON.stringify(c.to))}`;
             return `<li><time class="mono">${hhmmss(c.at)}</time><span class="ch-body">${what} <span class="rev-tag mono">r${c.revision}</span>${c.note ? `<span class="n">${esc(c.note)}</span>` : ""}</span></li>`;
           })
           .join("")}</ul>
       </div>`
    : "";

  const preserve = (["checkpoint", "worktree", "task"] as const)
    .map(
      (k) =>
        `<label class="toggle"><input type="checkbox" data-preserve="${k}" ${h.preserve[k] ? "checked" : ""} ${editable ? "" : "disabled"}><span class="mark" aria-hidden="true"></span><span class="txt">keep ${k}</span></label>`,
    )
    .join("");

  // Live mode only: the bridge can relaunch the real conversation on the route
  // the human approved. This is a human control; no tool reaches it.
  const resume =
    state.mode === "live" && h.status === "executed"
      ? `<div class="resume">
           <button class="btn approve" data-action="resume">Resume in a new terminal</button>
           ${state.bridge?.resumeCommand ? `<code class="resume-cmd mono">${esc(state.bridge.resumeCommand)}</code>` : ""}
           ${state.bridge?.resumeStatus ? `<p class="resume-status">${esc(state.bridge.resumeStatus)}</p>` : ""}
           <p class="resume-hint">Exit the blocked session first; this relaunches the same conversation on the approved model.</p>
         </div>`
      : "";

  const actions =
    h.status === "executed" && h.result
      ? `<div class="result"><span class="res-mark" aria-hidden="true">✓</span><p><b>Executed.</b> The session resumed on ${esc(label(state, h.result.active))} from checkpoint <span class="mono">${esc(h.result.checkpoint)}</span>, leaving ${esc(label(state, h.result.previous))} behind.</p></div>${resume}`
      : h.status === "rejected"
        ? `<div class="verdict rejected"><span aria-hidden="true">✕</span> Rejected. The agent sees this on its next <span class="mono">get_handoff</span> call.</div>`
        : h.status === "superseded"
          ? `<div class="verdict"><span aria-hidden="true">↺</span> Superseded by a newer proposal.</div>`
          : `<div class="actions">
              <button class="btn approve" data-action="approve" ${h.status === "approved" ? "disabled" : ""}>${h.status === "approved" ? "Approved · waiting for the agent" : "Approve handoff"}</button>
              <button class="btn danger" data-action="reject">Reject</button>
              <span class="hint">${
                h.status === "approved"
                  ? `Approval is bound to revision ${h.revision}. Any further edit revokes it.`
                  : `Approving binds the decision to revision ${h.revision}. No tool can do this for you.`
              }</span>
            </div>`;

  const meteredNote =
    target?.metered && !h.allowMetered
      ? `<p class="metered-note"><span aria-hidden="true">$</span> This target spends metered usage. Approving it overrides the proposal's <span class="mono">allow_metered=false</span>.</p>`
      : "";

  return `
    <section class="card handoff hero" aria-labelledby="handoff-h">
      <header id="handoff-h">
        <span class="h-title">Handoff proposal</span>
        <span class="by"><span class="who ${h.createdBy === "agent" ? "agent" : "human"}" aria-hidden="true">${ACTOR_GLYPH[h.createdBy === "agent" ? "agent" : "human"]}</span>proposed by ${esc(h.createdBy)}</span>
        <span class="count"><span class="mono">${esc(h.id)}</span> · rev ${h.revision}</span>
        <span class="hstatus ${h.status}">${esc(h.status.replace("_", " "))}</span>
      </header>
      <div class="body">
        <div class="fromto">
          <div class="box from">
            <span class="box-label">From</span>
            <div class="model">${esc(label(state, h.from))}</div>
            <div class="sub">${esc(fromRoute ? PROVIDER_LABEL[fromRoute.provider] : "")} <span class="mono">${esc(short(h.from))}</span></div>
          </div>
          <div class="arrow" aria-hidden="true"><span>→</span></div>
          <div class="box to ${editable ? "editable" : ""}">
            <span class="box-label" id="target-label">To${editable ? ` <em>yours to change</em>` : ""}</span>
            ${
              editable
                ? `<select data-action="target" id="handoff-target" aria-labelledby="target-label">${options}</select>`
                : `<div class="model">${esc(target?.label ?? short(h.target))}</div>`
            }
            <div class="sub">${esc(target ? PROVIDER_LABEL[target.provider] : "")} <span class="mono">${esc(short(h.target))}</span>${target?.metered ? `<span class="tag metered">$ metered</span>` : ""}</div>
          </div>
        </div>
        ${meteredNote}
        <blockquote class="reason">
          <span class="section-label"><span class="who agent" aria-hidden="true">◆</span> Agent's reason</span>
          <p>${esc(h.reason)}</p>
        </blockquote>
        <div class="controls-row">
          <fieldset class="preserve">
            <legend>Preserve</legend>
            ${preserve}
          </fieldset>
          <div class="note-field">
            <label for="handoff-note">Note for the record</label>
            <input id="handoff-note" class="note" data-action="note" placeholder="Optional, press Enter to save" value="${esc(h.note)}" ${editable ? "" : "disabled"} />
          </div>
        </div>
        ${changes}
        ${actions}
      </div>
    </section>`;
}

/* ---------------------------------------------------------------- streams */

function renderActivity(ctx: UiContext, state: RelayState): string {
  const registered = ctx.webmcp?.available ? ctx.webmcp.registered : [];
  const calls = state.agentCalls.slice(-30);
  const body = calls.length
    ? calls
        .map(
          (c) => `
            <li class="${c.ok ? "" : "failed"}">
              <time class="mono">${hhmmss(c.at)}</time>
              <span class="line">
                <span class="tool ${c.ok ? "" : "err"}"><span class="who agent" aria-hidden="true">${c.ok ? "◆" : "✕"}</span>${esc(c.tool)}</span>
                <span class="ms mono">${c.durationMs}ms</span>
              </span>
              <span class="sum">${esc(c.summary)}</span>
            </li>`,
        )
        .join("")
    : `<li class="empty">
         <p>No tool calls yet. Every WebMCP call the agent makes lands here as it happens.</p>
         ${
           registered.length
             ? `<div class="toolchips"><span class="chips-label">Registered on this page</span>${registered
                 .map((t) => `<span class="chip mono">${esc(t)}</span>`)
                 .join("")}</div>`
             : ""
         }
       </li>`;
  return `
    <section class="card stream" aria-labelledby="activity-h">
      <header id="activity-h"><span class="who agent" aria-hidden="true">◆</span> Agent activity <span class="count">${state.agentCalls.length} calls</span></header>
      <ul class="log" id="activity-log" aria-live="polite" aria-relevant="additions">${body}</ul>
    </section>`;
}

function renderEvents(state: RelayState): string {
  const events = state.events.slice(-40);
  const body = events
    .map(
      (e) => `
        <li class="${e.source === "relay" ? "highlight" : ""}">
          <time class="mono">${hhmmss(e.at)}</time>
          <span class="line">
            <span class="src ${e.source}" title="${esc(SOURCE_TITLE[e.source])}"><span aria-hidden="true">${SOURCE_GLYPH[e.source]}</span>${esc(e.source)}</span>
            <span class="kind mono">${esc(e.kind)}</span>
          </span>
          <span class="sum">${esc(e.summary)}</span>
        </li>`,
    )
    .join("");
  return `
    <section class="card stream" aria-labelledby="events-h">
      <header id="events-h"><span class="who runtime" aria-hidden="true">▣</span> Runtime events <span class="count">${state.events.length}</span></header>
      <ul class="log" id="events-log">${body}</ul>
    </section>`;
}

function renderReplay(state: RelayState): string {
  const body = state.replay
    .map(
      (e) => `
        <li>
          <time class="mono">${hhmmss(e.at)}</time>
          <span class="actor ${e.actor}"><span class="who ${e.actor}" aria-hidden="true">${ACTOR_GLYPH[e.actor]}</span>${esc(e.actor)}</span>
          <span class="what"><b>${esc(e.action)}</b>${e.detail ? `<span>${esc(e.detail)}</span>` : ""}</span>
        </li>`,
    )
    .join("");
  return `
    <section class="card replay-card" aria-labelledby="replay-h">
      <header id="replay-h">Replay <span class="count">who did what, in order</span></header>
      <ul class="replay">${body}</ul>
    </section>`;
}

function renderFooter(): string {
  const who = (["runtime", "agent", "human", "relay"] as const)
    .map((a) => `<span class="legend-item"><span class="who ${a}" aria-hidden="true">${ACTOR_GLYPH[a]}</span>${a}</span>`)
    .join("");
  return `
    <footer>
      <div class="legend" aria-label="Colour and glyph for each actor">${who}</div>
      <span class="foot-note">Approve and Reject exist only as buttons. There is deliberately no WebMCP tool for them.</span>
      <span class="foot-links"><a href="https://github.com/Harshkamdar67/Airlock" target="_blank" rel="noopener">Airlock</a><a href="https://github.com/Harshkamdar67/airlock-relay" target="_blank" rel="noopener">Source</a></span>
    </footer>`;
}

export function render(root: HTMLElement, ctx: UiContext): void {
  const state = ctx.store.get();
  const activeEl = document.activeElement as HTMLElement | null;
  const keepFocus = activeEl?.dataset?.action === "note" ? (activeEl as HTMLInputElement).value : null;
  root.innerHTML = `
    ${renderTopbar(ctx, state)}
    ${renderStatusBand(state)}
    ${renderBanner(ctx, state)}
    <main class="grid">
      <div class="col col-left">${renderSession(state)}${renderRoutes(state)}</div>
      <div class="col col-center">${renderHandoff(state)}${renderReplay(state)}</div>
      <div class="col col-right">${renderActivity(ctx, state)}${renderEvents(state)}</div>
    </main>
    ${renderFooter()}`;
  if (keepFocus !== null) {
    const note = root.querySelector<HTMLInputElement>('input[data-action="note"]');
    if (note) {
      note.value = keepFocus;
      note.focus();
    }
  }
  const pinToLatest = () => {
    for (const log of root.querySelectorAll<HTMLElement>(".log, .replay")) log.scrollTop = log.scrollHeight;
  };
  pinToLatest();
  // Web fonts and flex sizing can settle after this pass, so pin again once the
  // layout is final, to keep the newest row fully visible.
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(pinToLatest);
  void document.fonts?.ready?.then(pinToLatest);
}

export function bind(root: HTMLElement, ctx: UiContext): void {
  root.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    if (action === "approve") ctx.store.humanApprove();
    else if (action === "reject") ctx.store.humanReject();
    else if (action === "reset") ctx.onReset();
    else if (action === "walkthrough") ctx.onWalkthrough();
    else if (action === "resume") ctx.onResume();
    else if (action === "copy-prompt") {
      void navigator.clipboard?.writeText(SUGGESTED_PROMPT);
      target.textContent = "Copied";
      setTimeout(() => (target.textContent = "Copy prompt"), 1200);
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
