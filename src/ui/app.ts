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

// UI-only state that survives re-renders.
const collapsed = new Set<string>(["events"]);
const expandedCalls = new Set<number>();
interface Toast { id: number; kind: "ok" | "warn" | "info"; text: string; at: number }
const toasts: Toast[] = [];
let toastSeq = 0;
let seenEventId = -1;
let paletteOpen = false;
let paletteQuery = "";
let paletteIndex = 0;
let shortcutsOpen = false;
let rerender: (() => void) | null = null;

const TOAST_KINDS: Record<string, { kind: Toast["kind"]; text: (summary: string) => string }> = {
  handoff_proposed: { kind: "info", text: (s) => s },
  execute_refused: { kind: "warn", text: (s) => s },
  handoff_approved: { kind: "ok", text: (s) => s },
  handoff_edited: { kind: "info", text: (s) => s },
  handoff_executed: { kind: "ok", text: (s) => s },
  session_resumed: { kind: "ok", text: (s) => s },
  handoff_rejected: { kind: "warn", text: (s) => s },
  bridge_result: { kind: "info", text: (s) => s },
};

function pushToast(kind: Toast["kind"], text: string): void {
  toasts.push({ id: ++toastSeq, kind, text, at: Date.now() });
  while (toasts.length > 3) toasts.shift();
  setTimeout(() => {
    const cutoff = Date.now() - 5200;
    let removed = false;
    for (let i = toasts.length - 1; i >= 0; i -= 1) if (toasts[i].at < cutoff) { toasts.splice(i, 1); removed = true; }
    if (removed) rerender?.();
  }, 5400);
}

function collectToasts(state: RelayState): void {
  if (seenEventId < 0) {
    seenEventId = state.events.reduce((m, e) => Math.max(m, e.id), 0);
    return;
  }
  for (const e of state.events) {
    if (e.id <= seenEventId || e.source !== "relay") continue;
    const spec = TOAST_KINDS[e.kind];
    if (spec) pushToast(spec.kind, spec.text(e.summary));
  }
  seenEventId = state.events.reduce((m, e) => Math.max(m, e.id), seenEventId);
}

function buildReport(state: RelayState): string {
  const s = state.session;
  const h = state.handoff;
  const lines = [
    `# Airlock Relay incident report`,
    ``,
    `- Session: ${s.id} (${s.profile}), task: ${s.task}`,
    `- Status: ${s.status}${s.blockedReason ? ` (${s.blockedReason})` : ""}, active model ${s.activeModel}, context ${s.contextTokens} tokens, checkpoint ${s.checkpoint}`,
    h ? `- Handoff ${h.id} rev ${h.revision}: ${h.from} -> ${h.target}, ${h.status.replace("_", " ")}, proposed by ${h.createdBy}` : `- Handoff: none`,
    h ? `- Reason: ${h.reason}` : ``,
    ``,
    `## Timeline`,
    ``,
    ...state.replay.map((e) => `- ${e.at} ${ACTOR_LABEL[e.actor]}: ${e.action}${e.detail ? ` (${e.detail})` : ""}`),
  ];
  return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}

interface PaletteAction { id: string; label: string; hint?: string; run: () => void; when?: boolean }

function paletteActions(ctx: UiContext, state: RelayState): PaletteAction[] {
  const h = state.handoff;
  const editable = !!h && (h.status === "pending_approval" || h.status === "approved");
  const actions: PaletteAction[] = [
    { id: "approve", label: "Approve handoff", hint: "A", when: editable && h?.status !== "approved", run: () => ctx.store.humanApprove() },
    { id: "reject", label: "Reject handoff", hint: "R", when: editable, run: () => ctx.store.humanReject() },
    { id: "resume", label: "Resume in a new terminal", when: state.mode === "live" && h?.status === "executed", run: () => ctx.onResume() },
    { id: "copy-prompt", label: "Copy the prompt for your agent", when: state.session.status === "blocked" && !h, run: () => { void navigator.clipboard?.writeText(SUGGESTED_PROMPT); pushToast("ok", "Prompt copied"); } },
    { id: "report", label: "Copy incident report (Markdown)", run: () => { void navigator.clipboard?.writeText(buildReport(state)); pushToast("ok", "Incident report copied"); } },
    { id: "walkthrough", label: "Run the scripted walkthrough", when: !ctx.walkthroughRunning, run: () => ctx.onWalkthrough() },
    { id: "scenario-rate", label: "Scenario: rate limit", when: state.mode === "demo" && state.scenario !== "rate_limit", run: () => ctx.onScenario("rate_limit") },
    { id: "scenario-overflow", label: "Scenario: context overflow", when: state.mode === "demo" && state.scenario !== "context_overflow", run: () => ctx.onScenario("context_overflow") },
    { id: "reset", label: "Reset the demo", when: state.mode === "demo", run: () => ctx.onReset() },
    { id: "toggle-events", label: collapsed.has("events") ? "Show runtime events" : "Hide runtime events", run: () => { if (collapsed.has("events")) collapsed.delete("events"); else collapsed.add("events"); } },
    { id: "toggle-routes", label: collapsed.has("routes") ? "Show routes" : "Hide routes", run: () => { if (collapsed.has("routes")) collapsed.delete("routes"); else collapsed.add("routes"); } },
    { id: "shortcuts", label: "Keyboard shortcuts", hint: "?", run: () => { shortcutsOpen = true; } },
    { id: "overview", label: "Go to overview", run: () => { location.href = "../"; } },
    { id: "connect", label: "Go to connect guide", run: () => { location.href = "../connect/"; } },
  ];
  const q = paletteQuery.trim().toLowerCase();
  return actions.filter((a) => a.when !== false && (!q || a.label.toLowerCase().includes(q)));
}

function renderPalette(ctx: UiContext, state: RelayState): string {
  if (!paletteOpen) return "";
  const actions = paletteActions(ctx, state);
  const idx = Math.min(paletteIndex, Math.max(0, actions.length - 1));
  return `
    <div class="overlay" data-overlay="palette" role="dialog" aria-modal="true" aria-label="Command palette">
      <div class="palette">
        <input class="palette-input" data-palette-input placeholder="Type a command…" value="${esc(paletteQuery)}" autocomplete="off" spellcheck="false" />
        <ul class="palette-list" role="listbox">
          ${actions.length ? actions.map((a, i) => `<li role="option" aria-selected="${i === idx}" class="${i === idx ? "active" : ""}" data-palette-action="${a.id}"><span>${esc(a.label)}</span>${a.hint ? `<kbd>${esc(a.hint)}</kbd>` : ""}</li>`).join("") : `<li class="empty">No matching command</li>`}
        </ul>
        <div class="palette-foot"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> run</span><span><kbd>esc</kbd> close</span></div>
      </div>
    </div>`;
}

function renderShortcuts(): string {
  if (!shortcutsOpen) return "";
  return `
    <div class="overlay" data-overlay="shortcuts" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <div class="palette shortcuts">
        <h3>Keyboard shortcuts</h3>
        <dl>
          <div><dt><kbd>Ctrl</kbd><kbd>K</kbd></dt><dd>Command palette</dd></div>
          <div><dt><kbd>A</kbd></dt><dd>Approve the pending handoff</dd></div>
          <div><dt><kbd>R</kbd></dt><dd>Reject the pending handoff</dd></div>
          <div><dt><kbd>C</kbd></dt><dd>Copy the agent prompt</dd></div>
          <div><dt><kbd>E</kbd></dt><dd>Toggle runtime events</dd></div>
          <div><dt><kbd>?</kbd></dt><dd>This list</dd></div>
          <div><dt><kbd>Esc</kbd></dt><dd>Close</dd></div>
        </dl>
      </div>
    </div>`;
}

function renderToasts(): string {
  if (!toasts.length) return "";
  return `<div class="toasts" aria-live="polite">${toasts.map((t) => `<div class="toast ${t.kind}">${icon(t.kind === "ok" ? "check" : t.kind === "warn" ? "alert" : "relay")}<span>${esc(t.text)}</span></div>`).join("")}</div>`;
}

function renderPipeline(state: RelayState): string {
  const calls = new Set(state.agentCalls.map((c) => c.tool));
  const h = state.handoff;
  const readsDone = calls.has("get_session") && calls.has("get_routes");
  const readsStarted = calls.size > 0;
  const proposalDone = !!h && h.status !== "superseded";
  const approvalDone = !!h && (h.status === "approved" || h.status === "executed");
  const executedDone = !!h && h.status === "executed";
  const rejected = h?.status === "rejected";
  const stages = [
    { label: "Agent reads", who: "agent", done: readsDone, active: !readsDone && (readsStarted || state.session.status === "blocked") },
    { label: "Agent proposes", who: "agent", done: proposalDone, active: readsDone && !proposalDone },
    { label: "You approve", who: "human", done: approvalDone, active: proposalDone && !approvalDone && !rejected, failed: rejected },
    { label: "Agent executes", who: "agent", done: executedDone, active: approvalDone && !executedDone },
  ];
  return `
    <ol class="pipeline" aria-label="Handoff progress">
      ${stages.map((s, i) => `<li class="${s.done ? "done" : s.active ? "active" : ""}${(s as { failed?: boolean }).failed ? " failed" : ""} ${s.who}"><span class="p-n">${s.done ? icon("check") : (s as { failed?: boolean }).failed ? icon("x") : i + 1}</span><span class="p-l">${s.label}</span></li>`).join("")}
    </ol>`;
}

// ---- Icons (16px, 1.7px stroke) -----------------------------------------------

const ICON: Record<string, string> = {
  alert: '<path d="M12 9v4m0 4h.01M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  play: '<path d="M6 4.5v15l12-7.5z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  bot: '<rect x="4" y="7" width="16" height="12" rx="3"/><path d="M12 3v4M8 12h.01M16 12h.01M9 16h6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4"/>',
  relay: '<path d="M4 12h4l2-6 4 12 2-6h4"/>',
  git: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7M18 10.5c0 3-3 4-6 4s-6 1-6 3.5"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  terminal: '<path d="m5 7 5 5-5 5m8 0h6"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  route: '<circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="5" r="2.5"/><path d="M8.5 19H14a3 3 0 0 0 0-6h-4a3 3 0 0 1 0-6h5.5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  dot: '<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>',
};

function icon(name: string, cls = ""): string {
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name] ?? ""}</svg>`;
}

// ---- Helpers --------------------------------------------------------------------

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
  return `${m}:${String(s).padStart(2, "0")}`;
}

function clock(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function activeRoute(state: RelayState): Route | undefined {
  return state.routes.find((r) => short(r.id) === short(state.session.activeModel));
}

// ---- Top bar --------------------------------------------------------------------

function renderBar(ctx: UiContext, state: RelayState): string {
  const w = ctx.webmcp;
  const webmcp = !w
    ? `<span class="chip">Checking WebMCP</span>`
    : w.available
      ? `<span class="pill ok" title="${esc(w.registered.join(", "))}">${icon("dot")}WebMCP · ${w.registered.length} tools</span>`
      : `<span class="pill warn">${icon("dot")}WebMCP off</span>`;
  const mode =
    state.mode === "live"
      ? `<span class="pill live">${icon("dot")}Live</span>`
      : `<span class="pill demo" title="Seeded from a real Airlock router export. Nothing here is a real outage.">${icon("dot")}Demo</span>`;
  const scenario =
    state.mode === "demo"
      ? `<label class="select"><span class="sr-only">Demo scenario</span><select data-action="scenario" aria-label="Demo scenario">${SCENARIOS.map((s) => `<option value="${s.id}" ${s.id === state.scenario ? "selected" : ""}>${esc(s.title)}</option>`).join("")}</select>${icon("chevron", "caret")}</label>`
      : "";
  return `
    <header class="bar">
      <div class="bar-left">
        <span class="mark" aria-hidden="true"></span>
        <span class="product">Airlock Relay</span>
        <span class="sep"></span>
        <span class="crumb mono">${esc(state.mode === "live" && state.bridge?.sessionId ? state.bridge.sessionId.slice(0, 8) : state.session.id)}</span>
        <span class="crumb dim">${esc(state.session.profile)}</span>
      </div>
      <div class="bar-right">
        <nav class="bar-nav" aria-label="Site"><a href="../">Overview</a><a href="../connect/">Connect</a></nav>
        ${mode}
        ${webmcp}
        ${scenario}
        <button class="btn" data-action="walkthrough" ${ctx.walkthroughRunning ? "disabled" : ""}>${icon("play")}${ctx.walkthroughRunning ? "Running…" : "Walkthrough"}</button>
        <button class="btn" data-action="reset">Reset</button>
      </div>
    </header>`;
}

// ---- Status strip and KPIs ------------------------------------------------------

function statusCopy(state: RelayState): { title: string; sub: string } {
  const s = state.session;
  const active = activeRoute(state);
  if (s.status === "running") {
    const h = state.handoff;
    if (h?.status === "executed" && h.result) {
      return { title: `Running on ${label(state, h.result.active)}`, sub: `Handed off from ${label(state, h.result.previous)} and resumed at checkpoint ${h.result.checkpoint}. Nothing was lost.` };
    }
    return { title: `Running on ${active?.label ?? short(s.activeModel)}`, sub: `Making requests on ${PROVIDER_LABEL[s.activeProvider] ?? s.activeProvider}. A proposal appears here if the session stalls.` };
  }
  if (s.blockedReason === "context_overflow") {
    const room = state.routes.filter((r) => r.contextWindow >= s.contextTokens && short(r.id) !== short(s.activeModel)).length;
    return { title: `Context overflow on ${active?.label ?? short(s.activeModel)}`, sub: `${fmtTokens(s.contextTokens)} tokens do not fit the ${fmtTokens(active?.contextWindow ?? 0)} window. ${room} of ${state.routes.length} routes have room.` };
  }
  const cooling = state.routes.filter((r) => r.status === "cooldown");
  const head = active?.headroom;
  const reset = cooling.find((r) => r.cooldownUntil)?.cooldownUntil;
  const usage = head ? `${head.usedPercent}% of the ${head.window} plan window is used` : "The plan window is exhausted";
  return { title: `Rate limit on ${PROVIDER_LABEL[s.activeProvider] ?? s.activeProvider}`, sub: `${usage}${reset ? `, resets in ${countdown(reset)}` : ""}. ${cooling.length} of ${state.routes.length} routes are on cooldown.` };
}

function renderStatus(ctx: UiContext, state: RelayState): string {
  const s = state.session;
  const active = activeRoute(state);
  const { title, sub } = statusCopy(state);
  const pct = active ? Math.min(100, Math.round((s.contextTokens / active.contextWindow) * 100)) : 0;
  const ready = state.routes.filter((r) => r.status === "ready").length;
  const reset = state.routes.find((r) => r.status === "cooldown" && r.cooldownUntil)?.cooldownUntil;
  const w = ctx.webmcp;
  let callout = "";
  if (w && !w.available) {
    callout = `<div class="callout warn banner" role="status">${icon("alert")}<div><b>WebMCP is not available in this browser.</b> Open this page in the ChatGPT desktop app's browser, or in Chrome 149+ with <code>chrome://flags/#enable-webmcp-testing</code> enabled. The walkthrough shows the same flow without an agent.</div></div>`;
  } else if (s.status === "blocked" && !state.handoff) {
    callout = `
      <div class="callout ok banner" role="status">
        ${icon("bot")}
        <div class="callout-body">
          <b>Hand it to your agent.</b> Seven tools are registered on this page. Paste this into your browser agent:
          <div class="prompt"><span id="suggested-prompt">${esc(SUGGESTED_PROMPT)}</span><button class="btn small" data-action="copy-prompt">${icon("copy")}Copy</button></div>
        </div>
      </div>`;
  }
  return `
    <section class="strip ${s.status}">
      <div class="strip-main">
        <span class="status ${s.status}">${icon(s.status === "running" ? "check" : "alert")}${s.status === "blocked" ? "Blocked" : s.status === "running" ? "Running" : "Resuming"}</span>
        <div class="strip-text">
          <h1>${esc(title)}</h1>
          <p>${esc(sub)}</p>
        </div>
      </div>
      <dl class="kpis">
        <div><dt>Active model</dt><dd title="${esc(s.activeModel)}">${esc(active?.label ?? short(s.activeModel))}</dd></div>
        <div><dt>Context</dt><dd>${fmtTokens(s.contextTokens)}<span class="dim"> / ${fmtTokens(active?.contextWindow ?? 0)}</span><span class="meter" aria-hidden="true"><i style="width:${pct}%"></i></span></dd></div>
        <div><dt>Routes ready</dt><dd class="${ready === 0 ? "danger" : ""}">${ready}<span class="dim"> / ${state.routes.length}</span></dd></div>
        <div><dt>${reset ? "Cooldown ends" : "Checkpoint"}</dt><dd class="mono">${reset ? esc(countdown(reset)) : esc(s.checkpoint)}</dd></div>
      </dl>
    </section>
    <div class="taskline">
      <span class="task"><b>Task</b>${esc(s.task)}</span>
      <span><b>Checkpoint</b><span class="mono">${esc(s.checkpoint)}</span></span>
      <span><b>Worktree</b><span class="mono" title="${esc(s.workdir)}">${esc(s.workdir)}</span></span>
    </div>
    ${renderPipeline(state)}
    ${callout}`;
}

// ---- Proposal -------------------------------------------------------------------

function renderProposal(state: RelayState): string {
  const h = state.handoff;
  if (!h) {
    return `
      <section class="panel handoff" aria-labelledby="handoff-h">
        <header><h2 id="handoff-h">${icon("git")}Handoff proposal</h2><span class="dim">Nothing proposed yet</span></header>
        <ol class="steps">
          <li><span class="n">1</span><div><b>The agent reads</b>get_session, get_events and get_routes tell it what broke and what is still available.</div></li>
          <li><span class="n">2</span><div><b>The agent proposes</b>prepare_handoff writes a proposal here. Cooldown routes, routes without room, and metered routes it was not allowed are refused.</div></li>
          <li><span class="n">3</span><div><b>You decide</b>Change the target, add a note, then approve or reject. Approval is bound to the revision you saw.</div></li>
          <li><span class="n">4</span><div><b>The agent executes</b>execute_handoff resumes the work from its checkpoint, or is refused if you edited after approving.</div></li>
        </ol>
      </section>`;
  }
  const editable = h.status === "pending_approval" || h.status === "approved";
  const target = state.routes.find((r) => r.id === h.target);
  const fromRoute = state.routes.find((r) => r.id === h.from);
  const options = state.routes
    .filter((r) => r.status === "ready" && short(r.id) !== short(h.from) && r.contextWindow >= state.session.contextTokens)
    .map((r) => `<option value="${esc(r.id)}" ${r.id === h.target ? "selected" : ""}>${esc(r.label)} · ${esc(PROVIDER_LABEL[r.provider] ?? r.provider)}${r.metered ? " · metered" : ""}</option>`)
    .join("");
  const changes = h.humanChanges.length
    ? `<div class="field"><span class="lbl">What you changed</span><ul class="changes">${h.humanChanges
        .map((c) => {
          const what =
            c.field === "target"
              ? `Changed the target to <b>${esc(label(state, String(c.to)))}</b> <span class="dim">was ${esc(label(state, String(c.from)))}</span>`
              : c.field === "approval"
                ? `<b>Approved</b> revision ${c.revision}`
                : c.field === "rejection"
                  ? `<b>Rejected</b> the proposal`
                  : c.field === "note"
                    ? `Added a note`
                    : `Set ${esc(JSON.stringify(c.to))}`;
          return `<li><time class="mono">${hhmmss(c.at)}</time><span>${what}${c.note ? `<span class="note-warn">${esc(c.note)}</span>` : ""}</span></li>`;
        })
        .join("")}</ul></div>`
    : "";
  const preserve = (["checkpoint", "worktree", "task"] as const)
    .map((k) => `<label class="check"><input type="checkbox" data-preserve="${k}" ${h.preserve[k] ? "checked" : ""} ${editable ? "" : "disabled"}><span>Keep ${k}</span></label>`)
    .join("");
  let outcome = "";
  if (h.status === "executed" && h.result) {
    outcome = `<div class="callout ok">${icon("check")}<div><b>Executed.</b> The session resumed on ${esc(label(state, h.result.active))} from checkpoint <span class="mono">${esc(h.result.checkpoint)}</span>, leaving ${esc(label(state, h.result.previous))} behind.</div></div>`;
    if (state.mode === "live") {
      outcome += `
        <div class="resume">
          <div class="resume-head"><button class="btn primary" data-action="resume">${icon("terminal")}Resume in a new terminal</button><span>Exit the blocked session first. This relaunches the same conversation on the approved model.</span></div>
          ${state.bridge?.resumeCommand ? `<code class="cmd">${esc(state.bridge.resumeCommand)}</code>` : ""}
          ${state.bridge?.resumeStatus ? `<p class="dim">${esc(state.bridge.resumeStatus)}</p>` : ""}
        </div>`;
    }
  } else if (h.status === "rejected") {
    outcome = `<div class="callout muted">${icon("x")}<div>Rejected. The agent sees this on its next get_handoff call.</div></div>`;
  } else if (h.status === "superseded") {
    outcome = `<div class="callout muted">${icon("x")}<div>Superseded by a newer proposal.</div></div>`;
  } else {
    outcome = `
      <div class="actions">
        <button class="btn primary" data-action="approve" ${h.status === "approved" ? "disabled" : ""}>${icon("check")}${h.status === "approved" ? "Approved · waiting for the agent" : "Approve handoff"}</button>
        <button class="btn" data-action="reject">Reject</button>
        <span class="dim">${h.status === "approved" ? `Token issued for revision ${h.revision}. Any edit revokes it.` : "Approval issues a token bound to this revision."}</span>
      </div>`;
  }
  return `
    <section class="panel handoff" aria-labelledby="handoff-h">
      <header>
        <h2 id="handoff-h">${icon("git")}Handoff proposal</h2>
        <span class="meta"><span class="mono">${esc(h.id)}</span><span class="sep"></span>rev ${h.revision}<span class="sep"></span>${h.createdBy === "agent" ? `${icon("bot")} agent` : `${icon("user")} you`}</span>
        <span class="hstatus ${h.status}">${h.status.replace("_", " ")}</span>
      </header>
      <div class="body">
        <div class="fromto">
          <div class="box"><span class="lbl">From</span><div class="model">${esc(label(state, h.from))}</div><div class="mono dim">${esc(short(h.from))} · ${esc(PROVIDER_LABEL[fromRoute?.provider ?? ""] ?? "")}</div></div>
          <span class="arrow">${icon("arrow")}</span>
          <div class="box to ${editable ? "editable" : ""}">
            <span class="lbl">To${editable ? " · yours to change" : ""}</span>
            ${editable ? `<label class="select big"><span class="sr-only">Handoff target</span><select data-action="target" aria-label="Handoff target">${options}</select>${icon("chevron", "caret")}</label>` : `<div class="model">${esc(target?.label ?? short(h.target))}</div>`}
            <div class="mono dim">${esc(short(h.target))} · ${esc(PROVIDER_LABEL[target?.provider ?? ""] ?? "")}${target?.metered ? ' · <span class="metered">metered</span>' : ""}</div>
          </div>
        </div>
        ${target?.metered ? `<div class="callout warn">${icon("alert")}<div>This target spends metered usage. Approving it overrides the proposal's <span class="mono">allow_metered=false</span>.</div></div>` : ""}
        <div class="reason"><span class="lbl agent">${icon("bot")}Agent's reason</span><p>${esc(h.reason)}</p></div>
        <div class="row">
          <div class="field"><span class="lbl">Preserve</span><div class="checks">${preserve}</div></div>
          <div class="field grow"><label class="lbl" for="note-input">Note for the record</label><input id="note-input" class="input" data-action="note" placeholder="Optional, press Enter to save" value="${esc(h.note)}" ${editable ? "" : "disabled"} /></div>
        </div>
        ${changes}
        ${outcome}
      </div>
    </section>`;
}

// ---- Timeline -------------------------------------------------------------------

function renderTimeline(state: RelayState): string {
  const entries = state.replay.slice(-40);
  const body = entries
    .map((e) => `<li class="${e.actor}"><time class="mono">${hhmmss(e.at)}</time><span class="actor">${icon(e.actor === "agent" ? "bot" : e.actor === "human" ? "user" : e.actor === "runtime" ? "cpu" : "relay")}${ACTOR_LABEL[e.actor]}</span><span class="what"><b>${esc(e.action)}</b>${e.detail ? `<span class="dim"> ${esc(e.detail)}</span>` : ""}</span></li>`)
    .join("");
  return `
    <section class="panel" aria-labelledby="replay-h">
      <header><h2 id="replay-h">${icon("list")}Timeline</h2><span class="dim">Who did what, in order · ${state.replay.length}</span></header>
      <ul class="replay">${body}</ul>
    </section>`;
}

// ---- Side sections ------------------------------------------------------------------

function section(key: string, title: string, iconName: string, meta: string, body: string): string {
  const open = !collapsed.has(key);
  return `
    <section class="panel side-section ${open ? "open" : "closed"}" aria-labelledby="${key}-h">
      <header>
        <button class="disclosure" data-toggle="${key}" aria-expanded="${open}" aria-controls="${key}-body">${icon("chevron", "caret")}</button>
        <h2 id="${key}-h">${icon(iconName)}${title}</h2>
        <span class="dim">${meta}</span>
      </header>
      <div class="side-body" id="${key}-body" ${open ? "" : "hidden"}>${body}</div>
    </section>`;
}

function renderActivity(state: RelayState): string {
  const calls = state.agentCalls.slice(-30);
  const body = calls.length
    ? `<ul class="log activity" id="activity-log" aria-live="polite">${calls.map((c) => `<li class="${c.ok ? "" : "err"}${expandedCalls.has(c.id) ? " open" : ""}" data-call="${c.id}" title="Click to inspect input and output"><time class="mono">${hhmmss(c.at)}</time><span class="tool mono">${esc(c.tool)}</span><span class="ms mono">${c.durationMs} ms</span><span class="sum">${esc(c.summary)}</span>${expandedCalls.has(c.id) ? `<div class="io"><span class="lbl">Input</span><pre>${esc(JSON.stringify(c.input ?? {}, null, 1))}</pre><span class="lbl">Output</span><pre>${esc(c.output ?? "")}</pre></div>` : ""}</li>`).join("")}</ul>`
    : `<ul class="log activity" id="activity-log" aria-live="polite"><li class="empty"><span>No tool calls yet. Registered on this page:</span><span class="tools">${TOOL_NAMES.map((t) => `<code>${t}</code>`).join("")}</span></li></ul>`;
  return section("activity", "Agent activity", "bot", `${state.agentCalls.length} calls`, body);
}

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
            <div class="r-name">${esc(r.label)}${isActive ? '<span class="tag active">active</span>' : ""}${r.metered ? '<span class="tag metered">metered</span>' : ""}</div>
            <div class="r-meta">${esc(PROVIDER_LABEL[r.provider] ?? r.provider)} · ${esc(r.tier)} · ${fmtTokens(r.contextWindow)} ctx · ${fits ? '<span class="fit">fits</span>' : '<span class="nofit">no room</span>'}</div>
            ${head ? `<div class="r-head"><span class="bar" aria-hidden="true"><i style="width:${head.usedPercent}%" class="${head.usedPercent >= 90 ? "hot" : ""}"></i></span><span>${head.usedPercent}% of ${esc(head.window)}${head.usedPercent >= 90 && head.resetsAt ? ` · resets ${clock(head.resetsAt)}` : ""}</span></div>` : ""}
          </div>
          <div class="r-state"><span class="state">${r.status}</span>${left ? `<span class="left mono">${left}</span>` : ""}</div>
        </li>`;
    })
    .join("");
  const ready = state.routes.filter((r) => r.status === "ready").length;
  const noRoom = state.routes.filter((r) => r.contextWindow < s.contextTokens).length;
  return section("routes", "Routes", "route", `${ready} of ${state.routes.length} ready${noRoom ? ` · ${noRoom} without room` : ""}`, `<ul class="routes">${items}</ul>`);
}

function renderEvents(state: RelayState): string {
  const events = state.events.slice(-40);
  const body = `<ul class="log events" id="events-log">${events
    .map((e) => `<li class="${e.source === "relay" ? "relay" : ""}"><time class="mono">${hhmmss(e.at)}</time><span class="src ${esc(e.source)}">${esc(e.source)}</span><span class="sum"><span class="kind mono">${esc(e.kind)}</span> ${esc(e.summary)}</span></li>`)
    .join("")}</ul>`;
  return section("events", "Runtime events", "cpu", `<span title="Real events are tagged airlock, seeded ones scenario, page-made ones relay">${state.events.length} events</span>`, body);
}

// ---- Page ---------------------------------------------------------------------------

export function render(root: HTMLElement, ctx: UiContext): void {
  const state = ctx.store.get();
  rerender = () => render(root, ctx);
  collectToasts(state);
  const activeEl = document.activeElement as HTMLElement | null;
  const keepFocus = activeEl?.dataset?.action === "note" ? (activeEl as HTMLInputElement).value : null;
  const paletteCaret = activeEl && "paletteInput" in (activeEl.dataset ?? {}) ? (activeEl as HTMLInputElement).selectionStart : null;
  root.innerHTML = `
    ${renderBar(ctx, state)}
    ${renderStatus(ctx, state)}
    <main class="work">
      <div class="pane main">
        ${renderProposal(state)}
        ${renderTimeline(state)}
      </div>
      <aside class="pane side">
        ${renderActivity(state)}
        ${renderRoutes(state)}
        ${renderEvents(state)}
      </aside>
    </main>
    <footer>
      <span class="legend">${icon("cpu")}Runtime ${icon("bot")}Agent ${icon("user")}You ${icon("relay")}Relay</span>
      <span>Approve and Reject exist only as buttons. There is deliberately no WebMCP tool for them.</span>
      <span class="kbd-hint"><kbd>Ctrl</kbd><kbd>K</kbd> commands · <kbd>?</kbd> shortcuts</span>
      <span><a href="https://github.com/Harshkamdar67/Airlock" target="_blank" rel="noopener">Airlock</a> · <a href="https://github.com/Harshkamdar67/airlock-relay" target="_blank" rel="noopener">Source</a></span>
    </footer>
    ${renderToasts()}
    ${renderPalette(ctx, state)}
    ${renderShortcuts()}`;
  if (paletteOpen) {
    const input = root.querySelector<HTMLInputElement>("[data-palette-input]");
    if (input) {
      input.focus();
      const pos = paletteCaret ?? input.value.length;
      input.setSelectionRange(pos, pos);
    }
  }
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
  const isTyping = () => {
    const el = document.activeElement as HTMLElement | null;
    return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
  };
  const runPalette = (id: string) => {
    const action = paletteActions(ctx, ctx.store.get()).find((a) => a.id === id);
    paletteOpen = false;
    paletteQuery = "";
    paletteIndex = 0;
    action?.run();
    render(root, ctx);
  };
  document.addEventListener("keydown", (event) => {
    const key = event.key;
    if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === "k") {
      event.preventDefault();
      paletteOpen = !paletteOpen;
      shortcutsOpen = false;
      paletteQuery = "";
      paletteIndex = 0;
      render(root, ctx);
      return;
    }
    if (key === "Escape" && (paletteOpen || shortcutsOpen)) {
      paletteOpen = false;
      shortcutsOpen = false;
      render(root, ctx);
      return;
    }
    if (paletteOpen) {
      const actions = paletteActions(ctx, ctx.store.get());
      if (key === "ArrowDown") { event.preventDefault(); paletteIndex = Math.min(paletteIndex + 1, Math.max(0, actions.length - 1)); render(root, ctx); }
      else if (key === "ArrowUp") { event.preventDefault(); paletteIndex = Math.max(paletteIndex - 1, 0); render(root, ctx); }
      else if (key === "Enter") { event.preventDefault(); const a = actions[Math.min(paletteIndex, actions.length - 1)]; if (a) runPalette(a.id); }
      return;
    }
    if (isTyping() || event.ctrlKey || event.metaKey || event.altKey) return;
    const state = ctx.store.get();
    const h = state.handoff;
    const editable = !!h && (h.status === "pending_approval" || h.status === "approved");
    if (key === "?") { shortcutsOpen = !shortcutsOpen; render(root, ctx); }
    else if (key === "a" && editable && h?.status !== "approved") ctx.store.humanApprove();
    else if (key === "r" && editable) ctx.store.humanReject();
    else if (key === "c" && state.session.status === "blocked" && !h) { void navigator.clipboard?.writeText(SUGGESTED_PROMPT); pushToast("ok", "Prompt copied"); render(root, ctx); }
    else if (key === "e") { if (collapsed.has("events")) collapsed.delete("events"); else collapsed.add("events"); render(root, ctx); }
  });
  root.addEventListener("input", (event) => {
    const el = event.target as HTMLElement;
    if (el.matches("[data-palette-input]")) {
      paletteQuery = (el as HTMLInputElement).value;
      paletteIndex = 0;
      render(root, ctx);
    }
  });
  root.addEventListener("click", (event) => {
    const overlay = (event.target as HTMLElement).closest<HTMLElement>("[data-overlay]");
    if (overlay && event.target === overlay) {
      paletteOpen = false;
      shortcutsOpen = false;
      render(root, ctx);
      return;
    }
    const paletteItem = (event.target as HTMLElement).closest<HTMLElement>("[data-palette-action]");
    if (paletteItem) {
      runPalette(paletteItem.dataset.paletteAction as string);
      return;
    }
    const callRow = (event.target as HTMLElement).closest<HTMLElement>("[data-call]");
    if (callRow) {
      const id = Number(callRow.dataset.call);
      if (expandedCalls.has(id)) expandedCalls.delete(id);
      else expandedCalls.add(id);
      render(root, ctx);
      return;
    }
    const toggle = (event.target as HTMLElement).closest<HTMLElement>("[data-toggle]");
    if (toggle) {
      const key = toggle.dataset.toggle as string;
      if (collapsed.has(key)) collapsed.delete(key);
      else collapsed.add(key);
      render(root, ctx);
      return;
    }
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
      setTimeout(() => render(root, ctx), 1200);
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
