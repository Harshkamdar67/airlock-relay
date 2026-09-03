// Renders the control room from RelayState. The human's controls call the
// store's human* methods; nothing here is reachable by the agent.

import type { RelayStore } from "../runtime/state";
import type { Handoff, RelayState, Route } from "../runtime/types";

export interface UiContext {
  store: RelayStore;
  webmcp: { available: boolean; registered: string[]; errors: string[] } | null;
  onReset: () => void;
  onWalkthrough: () => void;
  walkthroughRunning: boolean;
}

const SUGGESTED_PROMPT =
  "My Airlock coding session looks blocked. Inspect what happened, then get it running again on a route that is ready and does not spend metered usage. Do not change the active model until I approve the handoff in this page.";

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
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function minutesLeft(iso?: string): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "";
  return `${Math.ceil(ms / 60000)} min`;
}

function renderTopbar(ctx: UiContext, state: RelayState): string {
  const w = ctx.webmcp;
  const webmcpPill = !w
    ? `<span class="pill">checking WebMCP…</span>`
    : w.available
      ? `<span class="pill ok" title="${esc(w.registered.join(", "))}"><span class="blink"></span> WebMCP: ${w.registered.length} tools registered</span>`
      : `<span class="pill warn">WebMCP not detected</span>`;
  const mode = state.mode === "live" ? `<span class="pill live"><span class="blink"></span> LIVE Airlock session</span>` : `<span class="pill">DEMO session</span>`;
  return `
    <div class="topbar">
      <div class="wordmark"><span class="dot"></span>AIRLOCK RELAY <small>human + agent control room</small></div>
      <div class="spacer"></div>
      ${mode}
      ${webmcpPill}
      <button class="btn small" data-action="walkthrough" ${ctx.walkthroughRunning ? "disabled" : ""}>${ctx.walkthroughRunning ? "Walkthrough running…" : "Run scripted walkthrough"}</button>
      <button class="btn small" data-action="reset">Reset demo</button>
    </div>`;
}

function renderBanner(ctx: UiContext, state: RelayState): string {
  const w = ctx.webmcp;
  if (w && !w.available) {
    return `
      <div class="banner" role="status">
        <div>WebMCP is not available in this browser. Open this page in the ChatGPT desktop app's browser, or in Chrome 149+ with <code>chrome://flags/#enable-webmcp-testing</code> enabled. The scripted walkthrough shows the same flow without an agent.</div>
      </div>`;
  }
  if (state.handoff || state.session.status !== "blocked") return "";
  return `
    <div class="banner ok" role="status">
      <div class="prompt">
        <div>Tools are registered. Ask your browser agent to take over. Suggested prompt:</div>
        <div class="prompt-box"><p id="suggested-prompt">${esc(SUGGESTED_PROMPT)}</p><button class="btn small" data-action="copy-prompt">Copy</button></div>
      </div>
    </div>`;
}

function renderSession(state: RelayState): string {
  const s = state.session;
  const active = state.routes.find((r) => short(r.id) === short(s.activeModel));
  const pct = active ? Math.min(100, Math.round((s.contextTokens / active.contextWindow) * 100)) : 0;
  const reason = s.blockedReason ? ` · ${s.blockedReason.replace("_", " ")}` : "";
  return `
    <section class="card session" aria-labelledby="session-h">
      <header id="session-h">Session <span class="count mono">${esc(s.id)}</span></header>
      <div class="body">
        <p class="task">${esc(s.task)}</p>
        <dl class="kv">
          <dt>Status</dt><dd><span class="status ${s.status}">${s.status}${reason}</span></dd>
          <dt>Active model</dt><dd><b>${esc(active?.label ?? short(s.activeModel))}</b><div class="mono" style="color:var(--dim)">${esc(s.activeModel)} · ${esc(s.activeProvider)}</div></dd>
          <dt>Context</dt><dd>${fmtTokens(s.contextTokens)} tokens${active ? ` of ${fmtTokens(active.contextWindow)}` : ""}<div class="meter"><i style="width:${pct}%"></i></div></dd>
          <dt>Checkpoint</dt><dd class="mono">${esc(s.checkpoint)}</dd>
          <dt>Worktree</dt><dd class="mono">${esc(s.workdir)}</dd>
          <dt>Profile</dt><dd class="mono">${esc(s.profile)}</dd>
        </dl>
      </div>
    </section>`;
}

function renderRoutes(state: RelayState): string {
  const active = short(state.session.activeModel);
  const items = state.routes
    .map((r: Route) => {
      const isActive = short(r.id) === active;
      const left = minutesLeft(r.cooldownUntil);
      return `
        <li class="${r.status}${isActive ? " active" : ""}">
          <div class="name">${esc(r.label)}</div>
          <div class="meta">${esc(r.provider)} · ${esc(r.tier)} · ${fmtTokens(r.contextWindow)} ctx${r.metered ? '<span class="tag metered">metered</span>' : ""}${isActive ? '<span class="tag active">active</span>' : ""}</div>
          <div class="state">${r.status}${left ? `<br><span style="color:var(--dim);font-weight:500;text-transform:none;letter-spacing:0">${left}</span>` : ""}</div>
        </li>`;
    })
    .join("");
  return `
    <section class="card" aria-labelledby="routes-h">
      <header id="routes-h">Routes <span class="count">${state.routes.filter((r) => r.status === "ready").length} ready</span></header>
      <ul class="routes">${items}</ul>
    </section>`;
}

function renderHandoff(state: RelayState): string {
  const h = state.handoff;
  if (!h) {
    return `
      <section class="card handoff" aria-labelledby="handoff-h">
        <header id="handoff-h">Handoff proposal</header>
        <div class="body">
          <div class="empty">
            <h3>No proposal yet</h3>
            <p>${state.session.status === "blocked" ? "The session is blocked. An agent can inspect it through WebMCP and propose a handoff here. You decide whether it happens." : "The session is running."}</p>
          </div>
        </div>
      </section>`;
  }
  const editable = h.status === "pending_approval" || h.status === "approved";
  const target = state.routes.find((r) => r.id === h.target);
  const ready = state.routes.filter((r) => r.status === "ready" && short(r.id) !== short(h.from));
  const options = ready
    .map((r) => `<option value="${esc(r.id)}" ${r.id === h.target ? "selected" : ""}>${esc(r.label)}${r.metered ? " (metered)" : ""} · ${esc(r.provider)}</option>`)
    .join("");
  const changes = h.humanChanges.length
    ? `<ul class="changes">${h.humanChanges
        .map((c) => {
          const what =
            c.field === "target"
              ? `changed target ${esc(label(state, String(c.from)))} → ${esc(label(state, String(c.to)))}`
              : c.field === "approval"
                ? `approved revision ${c.revision}`
                : c.field === "rejection"
                  ? "rejected the proposal"
                  : c.field === "note"
                    ? `added a note`
                    : `set ${esc(JSON.stringify(c.to))}`;
          return `<li><time>${hhmmss(c.at)}</time> <b>Human</b> ${what} <span style="color:var(--dim)">(r${c.revision})</span>${c.note ? `<div class="n">${esc(c.note)}</div>` : ""}</li>`;
        })
        .join("")}</ul>`
    : "";
  const preserve = (["checkpoint", "worktree", "task"] as const)
    .map((k) => `<label><input type="checkbox" data-preserve="${k}" ${h.preserve[k] ? "checked" : ""} ${editable ? "" : "disabled"}> keep ${k}</label>`)
    .join("");
  const actions =
    h.status === "executed" && h.result
      ? `<div class="result"><b>Executed.</b> Session resumed on ${esc(label(state, h.result.active))} from checkpoint <span class="mono">${esc(h.result.checkpoint)}</span>. Previous model: ${esc(label(state, h.result.previous))}.</div>`
      : h.status === "rejected"
        ? `<div class="actions"><span class="hint">Rejected. The agent will see this on its next get_handoff call.</span></div>`
        : h.status === "superseded"
          ? `<div class="actions"><span class="hint">Superseded by a newer proposal.</span></div>`
          : `<div class="actions">
              <button class="btn primary" data-action="approve" ${h.status === "approved" ? "disabled" : ""}>${h.status === "approved" ? "Approved · waiting for agent" : "Approve handoff"}</button>
              <button class="btn danger" data-action="reject">Reject</button>
              <span class="hint">${h.status === "approved" ? `Token issued for revision ${h.revision}. Any edit revokes it.` : "Approval issues a token bound to this revision."}</span>
            </div>`;
  return `
    <section class="card handoff" aria-labelledby="handoff-h">
      <header id="handoff-h">Handoff proposal <span class="count">proposed by ${h.createdBy}</span></header>
      <div class="body">
        <div class="handoff-head"><span class="id">${esc(h.id)}</span><span class="hstatus ${h.status}">${h.status.replace("_", " ")}</span><span class="rev">revision ${h.revision}</span></div>
        <div class="fromto">
          <div class="box"><label>From</label><div class="model">${esc(label(state, h.from))}</div><div class="sub mono">${esc(h.from)}</div></div>
          <div class="arrow">→</div>
          <div class="box ${editable ? "editable" : ""}"><label>To ${editable ? "(you can change this)" : ""}</label>
            ${editable ? `<select data-action="target" aria-label="Handoff target">${options}</select>` : `<div class="model">${esc(target?.label ?? short(h.target))}</div>`}
            <div class="sub mono">${esc(h.target)}${target?.metered ? " · metered" : ""}</div>
          </div>
        </div>
        <div class="reason"><label>Agent's reason</label>${esc(h.reason)}</div>
        <div class="preserve">${preserve}</div>
        <input class="note" data-action="note" placeholder="Optional note for the record (Enter to save)" value="${esc(h.note)}" ${editable ? "" : "disabled"} />
        ${changes}
        ${actions}
      </div>
    </section>`;
}

function renderActivity(state: RelayState): string {
  const calls = state.agentCalls.slice(-30);
  const body = calls.length
    ? calls
        .map(
          (c) => `<li><time>${hhmmss(c.at)}</time><span class="tool ${c.ok ? "" : "err"}">${esc(c.tool)}</span><span class="sum">→ ${esc(c.summary)} <span style="color:var(--dim)">${c.durationMs}ms</span></span></li>`,
        )
        .join("")
    : `<li class="empty" style="display:block">No agent calls yet. Every WebMCP tool call lands here as it happens.</li>`;
  return `
    <section class="card" aria-labelledby="activity-h">
      <header id="activity-h">Agent activity <span class="count">${state.agentCalls.length} calls</span></header>
      <ul class="log" id="activity-log">${body}</ul>
    </section>`;
}

function renderEvents(state: RelayState): string {
  const events = state.events.slice(-40);
  const body = events
    .map((e) => `<li class="${e.source === "relay" ? "highlight" : ""}"><time>${hhmmss(e.at)}</time><span><span class="src ${e.source}">${e.source}</span><span class="kind">${esc(e.kind)}</span></span><span class="sum">${esc(e.summary)}</span></li>`)
    .join("");
  return `
    <section class="card" aria-labelledby="events-h">
      <header id="events-h">Runtime events <span class="count">${state.events.length}</span></header>
      <ul class="log" id="events-log">${body}</ul>
    </section>`;
}

function renderReplay(state: RelayState): string {
  const body = state.replay
    .map((e) => `<li><time>${hhmmss(e.at)}</time><span class="actor ${e.actor}">${e.actor}</span><span class="what"><b>${esc(e.action)}</b>${e.detail ? ` <span>· ${esc(e.detail)}</span>` : ""}</span></li>`)
    .join("");
  return `
    <section class="card" aria-labelledby="replay-h">
      <header id="replay-h">Replay <span class="count">who did what, in order</span></header>
      <ul class="replay">${body}</ul>
    </section>`;
}

export function render(root: HTMLElement, ctx: UiContext): void {
  const state = ctx.store.get();
  const activeEl = document.activeElement as HTMLElement | null;
  const keepFocus = activeEl?.dataset?.action === "note" ? (activeEl as HTMLInputElement).value : null;
  root.innerHTML = `
    ${renderTopbar(ctx, state)}
    ${renderBanner(ctx, state)}
    <main class="grid">
      <div class="col col-left">${renderSession(state)}${renderRoutes(state)}</div>
      <div class="col col-center">${renderHandoff(state)}${renderReplay(state)}</div>
      <div class="col col-right">${renderActivity(state)}${renderEvents(state)}</div>
    </main>
    <footer>
      <span>Airlock Relay · WebMCP control room for <a href="https://github.com/Harshkamdar67/Airlock" target="_blank" rel="noopener">Airlock</a> sessions</span>
      <span>Approve and Reject exist only as buttons. There is no WebMCP tool for them on purpose.</span>
      <span><a href="https://github.com/Harshkamdar67/airlock-relay" target="_blank" rel="noopener">Source</a></span>
    </footer>`;
  if (keepFocus !== null) {
    const note = root.querySelector<HTMLInputElement>('input[data-action="note"]');
    if (note) {
      note.value = keepFocus;
      note.focus();
    }
  }
  for (const log of root.querySelectorAll<HTMLElement>(".log")) log.scrollTop = log.scrollHeight;
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
    else if (action === "copy-prompt") {
      void navigator.clipboard?.writeText(SUGGESTED_PROMPT);
      target.textContent = "Copied";
      setTimeout(() => (target.textContent = "Copy"), 1200);
    }
  });
  root.addEventListener("change", (event) => {
    const el = event.target as HTMLElement;
    if (el.matches('select[data-action="target"]')) ctx.store.humanSetTarget((el as HTMLSelectElement).value);
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
