// Pure tool handlers. They take the store and validated input and return
// bounded, JSON-serialisable results. register.ts wraps them for WebMCP;
// tests call them directly; the no-agent walkthrough calls them too.

import type { RelayStore } from "../runtime/state";
import type { Handoff, RelayEvent, ToolResult } from "../runtime/types";

export const MAX_EVENTS = 40;
export const MAX_REPLAY = 60;

export interface ToolSpec<I, O> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; untrustedContentHint?: boolean };
  run(store: RelayStore, input: I): ToolResult<O>;
  summarize(result: ToolResult<O>, input: I): string;
  /** Optional richer one-sentence message for successful results. */
  message?(result: ToolResult<O>, input: I, store: RelayStore): string;
}

function short(model: string): string {
  return model.replace(/\[1m\]$/, "");
}

function publicHandoff(h: Handoff, includeToken: boolean) {
  const { approvalToken, ...rest } = h;
  return includeToken && h.status === "approved" ? { ...rest, approval_token: approvalToken } : rest;
}

function publicEvent(e: RelayEvent) {
  return { id: e.id, at: e.at, source: e.source, kind: e.kind, summary: e.summary };
}

export const getSession: ToolSpec<Record<string, never>, { session: unknown; handoff_id: string | null; next_step: string }> = {
  name: "get_session",
  description:
    "Read the live state of the Airlock coding session this page supervises: the task, the active model and provider, whether the session is running or blocked and why (rate_limit or context_overflow), context size against the active model's window, and the last checkpoint. Call this first.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
  run(store) {
    const { session, handoff, mode, scenario, routes } = store.get();
    const active = routes.find((r) => r.id === session.activeModel || r.id.replace(/\[1m\]$/, "") === session.activeModel.replace(/\[1m\]$/, ""));
    const next_step =
      session.status === "blocked"
        ? handoff
          ? `A handoff ${handoff.id} exists with status ${handoff.status}; call get_handoff.`
          : "Call get_events to see what happened, then get_routes, then prepare_handoff."
        : "The session is running. Nothing needs to be done unless the human asks.";
    return {
      ok: true,
      session: {
        id: session.id,
        mode,
        scenario: mode === "demo" ? scenario : null,
        task: session.task,
        profile: session.profile,
        active_model: session.activeModel,
        active_provider: session.activeProvider,
        status: session.status,
        blocked_reason: session.blockedReason ?? null,
        context_tokens: session.contextTokens,
        context_window: active?.contextWindow ?? null,
        checkpoint: session.checkpoint,
        workdir: session.workdir,
        started_at: session.startedAt,
      },
      handoff_id: handoff?.id ?? null,
      next_step,
    };
  },
  summarize(r) {
    if (!r.ok) return r.error.code;
    const s = r.session as { status: string; active_model: string; blocked_reason: string | null };
    return `${s.status}${s.blocked_reason ? ` (${s.blocked_reason})` : ""} on ${short(s.active_model)}`;
  },
  message(r) {
    if (!r.ok) return r.error.code;
    const s = r.session as { status: string; active_model: string; blocked_reason: string | null; task: string; context_tokens: number; context_window: number | null };
    if (s.status === "blocked") return `The session "${s.task}" is blocked on ${short(s.active_model)} because of a ${String(s.blocked_reason).replace("_", " ")}; the conversation is ${Math.round(s.context_tokens / 1000)}k tokens. ${r.next_step}`;
    return `The session is running on ${short(s.active_model)}. ${r.next_step}`;
  },
};

export interface GetEventsInput {
  since_id?: number;
  limit?: number;
  kinds?: string[];
}

export const getEvents: ToolSpec<GetEventsInput, { events: unknown[]; total: number; truncated: boolean }> = {
  name: "get_events",
  description:
    "Read the router's recent runtime events in order: requests, rate limits, cooldowns, failover attempts, and handoff activity. Use since_id to read only what is new. Summaries can contain text relayed from upstream providers.",
  inputSchema: {
    type: "object",
    properties: {
      since_id: { type: "number", description: "Return only events with an id greater than this." },
      limit: { type: "number", description: `Maximum events to return, up to ${MAX_EVENTS}. Defaults to ${MAX_EVENTS}.` },
      kinds: { type: "array", items: { type: "string" }, description: "Optional list of event kinds to keep, for example rate_limit_chain_exhausted." },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, untrustedContentHint: true },
  run(store, input) {
    const all = store.get().events;
    const since = typeof input.since_id === "number" ? input.since_id : 0;
    const kinds = Array.isArray(input.kinds) && input.kinds.length ? new Set(input.kinds) : null;
    const filtered = all.filter((e) => e.id > since && (!kinds || kinds.has(e.kind)));
    const limit = Math.max(1, Math.min(MAX_EVENTS, Number(input.limit) || MAX_EVENTS));
    const slice = filtered.slice(-limit);
    return { ok: true, events: slice.map(publicEvent), total: filtered.length, truncated: slice.length < filtered.length };
  },
  summarize(r) {
    return r.ok ? `${r.events.length} events${r.truncated ? " (truncated)" : ""}` : r.error.code;
  },
};

export const getRoutes: ToolSpec<Record<string, never>, { routes: unknown[]; active_model: string }> = {
  name: "get_routes",
  description:
    "List every model route Airlock can hand this session to, with provider, capability tier, context window, plan headroom for its provider, whether it is ready or on cooldown, and whether using it spends metered extra usage. Prefer ready, non-metered routes whose context window fits the session, unless the human said otherwise.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
  run(store) {
    const { routes, session } = store.get();
    return {
      ok: true,
      active_model: session.activeModel,
      routes: routes.map((r) => ({
        id: r.id,
        label: r.label,
        provider: r.provider,
        tier: r.tier,
        status: r.status,
        cooldown_until: r.cooldownUntil ?? null,
        metered: r.metered,
        context_window: r.contextWindow,
        fits_session_context: r.contextWindow >= session.contextTokens,
        provider_headroom: r.headroom ? { window: r.headroom.window, used_percent: r.headroom.usedPercent, resets_at: r.headroom.resetsAt } : null,
        is_active: short(r.id) === short(session.activeModel),
      })),
    };
  },
  summarize(r) {
    if (!r.ok) return r.error.code;
    const ready = (r.routes as Array<{ status: string }>).filter((x) => x.status === "ready").length;
    return `${r.routes.length} routes, ${ready} ready`;
  },
  message(r) {
    if (!r.ok) return r.error.code;
    const routes = r.routes as Array<{ id: string; status: string; metered: boolean; fits_session_context: boolean; is_active: boolean }>;
    const good = routes.filter((x) => x.status === "ready" && !x.metered && x.fits_session_context && !x.is_active).map((x) => x.id);
    const meteredOnly = routes.filter((x) => x.status === "ready" && x.metered && x.fits_session_context && !x.is_active).map((x) => x.id);
    if (good.length) return `Ready, non-metered routes that fit this session: ${good.join(", ")}. Prefer one of these unless the human said otherwise.`;
    if (meteredOnly.length) return `No non-metered route is ready and fits. Metered routes that would work: ${meteredOnly.join(", ")}; use allow_metered only if the human accepts the spend.`;
    return "No route is ready and fits the session right now. Tell the human when the cooldowns reset.";
  },
};

export interface PrepareHandoffToolInput {
  target: string;
  reason: string;
  allow_metered?: boolean;
  preserve_checkpoint?: boolean;
  preserve_worktree?: boolean;
  preserve_task?: boolean;
}

export const prepareHandoff: ToolSpec<PrepareHandoffToolInput, { handoff: unknown; next_step: string }> = {
  name: "prepare_handoff",
  description:
    "Propose moving the blocked session to another route. This does not switch anything: it creates a proposal the human reviews, may edit, and must approve in the page. Refused when the route is on cooldown, when its context window is smaller than the session, or when it is metered and allow_metered is not true; each refusal lists alternatives. Returns the proposal id to poll with get_handoff.",
  inputSchema: {
    type: "object",
    properties: {
      target: { type: "string", description: "Route id from get_routes, for example gpt-5.6-sol." },
      reason: { type: "string", minLength: 8, maxLength: 400, description: "One or two sentences the human will read: why this route, what is preserved." },
      allow_metered: { type: "boolean", description: "Set true only if the human said metered extra usage is acceptable. Defaults to false." },
      preserve_checkpoint: { type: "boolean", description: "Resume from the last checkpoint. Defaults to true." },
      preserve_worktree: { type: "boolean", description: "Keep the current git worktree. Defaults to true." },
      preserve_task: { type: "boolean", description: "Carry the task description over. Defaults to true." },
    },
    required: ["target", "reason"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false },
  run(store, input) {
    const preserve: Record<string, boolean> = {};
    if (typeof input.preserve_checkpoint === "boolean") preserve.checkpoint = input.preserve_checkpoint;
    if (typeof input.preserve_worktree === "boolean") preserve.worktree = input.preserve_worktree;
    if (typeof input.preserve_task === "boolean") preserve.task = input.preserve_task;
    const r = store.prepareHandoff({ target: String(input.target ?? ""), reason: String(input.reason ?? ""), allow_metered: input.allow_metered, preserve }, "agent");
    if (!r.ok) return r;
    return {
      ok: true,
      handoff: publicHandoff(r.handoff, false),
      next_step: `Tell the human ${r.handoff.id} is waiting for approval in the Relay page. Do not call execute_handoff until get_handoff reports status approved and returns an approval_token.`,
    };
  },
  summarize(r, input) {
    return r.ok ? `${(r.handoff as Handoff).id} → ${short(String(input.target))}` : r.error.code;
  },
  message(r) {
    if (!r.ok) return r.error.code;
    const h = r.handoff as Handoff;
    return `Proposal ${h.id} created: ${short(h.from)} → ${short(h.target)}. Nothing has switched. ${r.next_step}`;
  },
};

export const getHandoff: ToolSpec<{ handoff_id?: string }, { handoff: unknown; human_changes_since_created: number; next_step: string }> = {
  name: "get_handoff",
  description:
    "Read the current handoff proposal: status, revision, target, what the human changed since it was proposed, and, once approved, the approval_token needed by execute_handoff. Re-read this before executing; the human may have edited the proposal.",
  inputSchema: {
    type: "object",
    properties: { handoff_id: { type: "string", description: "Optional. Defaults to the current proposal." } },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  run(store, input) {
    const h = store.get().handoff;
    if (!h || (input.handoff_id && input.handoff_id !== h.id)) {
      return { ok: false, error: { code: "HANDOFF_NOT_FOUND", message: input.handoff_id ? `No handoff ${input.handoff_id}.` : "No handoff has been proposed.", hint: h ? `The current handoff is ${h.id}.` : "Call prepare_handoff first." } };
    }
    const next_step =
      h.status === "pending_approval"
        ? "Wait for the human to approve in the page, then call get_handoff again."
        : h.status === "approved"
          ? `Approved at revision ${h.revision}. Read human_changes, then call execute_handoff with handoff_id and approval_token.`
          : h.status === "executed"
            ? "Already executed. Call get_session to confirm the session is running."
            : h.status === "rejected"
              ? "The human rejected this. Ask what they prefer before proposing again."
              : "Superseded by a newer proposal.";
    return { ok: true, handoff: publicHandoff(h, true), human_changes_since_created: h.humanChanges.length, next_step };
  },
  summarize(r) {
    if (!r.ok) return r.error.code;
    const h = r.handoff as { id: string; status: string; revision: number };
    return `${h.id} ${h.status} r${h.revision}`;
  },
  message(r) {
    if (!r.ok) return r.error.code;
    const h = r.handoff as Handoff & { approval_token?: string };
    const changes = h.humanChanges.filter((c) => c.field === "target").map((c) => `target changed ${short(String(c.from))} → ${short(String(c.to))}${c.note ? ` (${c.note})` : ""}`);
    const changed = changes.length ? ` The human ${changes.join("; ")}.` : "";
    return `${h.id} is ${h.status.replace("_", " ")} at revision ${h.revision}, target ${short(h.target)}.${changed} ${r.next_step}`;
  },
};

export interface ExecuteHandoffToolInput {
  handoff_id: string;
  approval_token: string;
}

export const executeHandoff: ToolSpec<ExecuteHandoffToolInput, { result: unknown; handoff: unknown; already_executed: boolean }> = {
  name: "execute_handoff",
  description:
    "Carry out an approved handoff so the session resumes on the new route from its checkpoint. Call it after get_handoff reports status approved and pass the approval_token it returned. Without a valid token it fails with APPROVAL_REQUIRED (not yet approved) or STALE_APPROVAL (the human edited the proposal after approving). Safe to retry: a second call returns the same result.",
  inputSchema: {
    type: "object",
    properties: {
      handoff_id: { type: "string", description: "The proposal id, for example H-229." },
      approval_token: { type: "string", description: "Token returned by get_handoff once the human approved. Required for execution; omitting it only reports whether approval exists." },
    },
    required: ["handoff_id"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false },
  run(store, input) {
    const r = store.executeHandoff({ handoff_id: String(input.handoff_id ?? ""), approval_token: input.approval_token ? String(input.approval_token) : undefined });
    if (!r.ok) return r;
    return { ok: true, result: r.result, handoff: publicHandoff(r.handoff, false), already_executed: r.already_executed };
  },
  summarize(r) {
    if (!r.ok) return r.error.code;
    const res = r.result as { active: string };
    return `${r.already_executed ? "already " : ""}resumed on ${short(res.active)}`;
  },
  message(r) {
    if (!r.ok) return r.error.code;
    const res = r.result as { active: string; previous: string; checkpoint: string };
    return `${r.already_executed ? "Already executed earlier. " : ""}The session resumed on ${short(res.active)} from checkpoint ${res.checkpoint}, leaving ${short(res.previous)}. Tell the human, then call get_replay if they want the timeline.`;
  },
};

export const getReplay: ToolSpec<{ limit?: number }, { replay: unknown[]; total: number }> = {
  name: "get_replay",
  description:
    "Read the attributed timeline of this session: what the runtime did, every tool the agent called, and every edit or approval the human made in the page, in order. Use it to explain to the human what happened.",
  inputSchema: {
    type: "object",
    properties: { limit: { type: "number", description: `Maximum entries, up to ${MAX_REPLAY}.` } },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  run(store, input) {
    const all = store.get().replay;
    const limit = Math.max(1, Math.min(MAX_REPLAY, Number(input.limit) || MAX_REPLAY));
    const slice = all.slice(-limit);
    return { ok: true, replay: slice.map((e) => ({ id: e.id, at: e.at, actor: e.actor, action: e.action, detail: e.detail ?? null })), total: all.length };
  },
  summarize(r) {
    return r.ok ? `${r.replay.length} entries` : r.error.code;
  },
};

export const TOOLS: ToolSpec<any, any>[] = [getSession, getEvents, getRoutes, prepareHandoff, getHandoff, executeHandoff, getReplay];

/** Run a tool by name with attribution and timing. This is the only entry point WebMCP and the walkthrough use. */
export function invokeTool(store: RelayStore, name: string, input: unknown): ToolResult<unknown> {
  const spec = TOOLS.find((t) => t.name === name);
  if (!spec) return { ok: false, error: { code: "UNKNOWN_TOOL", message: `No tool named ${name}.` } };
  const started = typeof performance !== "undefined" ? performance.now() : Date.now();
  const safeInput = input && typeof input === "object" ? input : {};
  const replayId = store.beginAgentCall(name, safeInput);
  let result: ToolResult<unknown>;
  try {
    result = spec.run(store, safeInput);
  } catch (error) {
    result = { ok: false, error: { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) } };
  }
  const ended = typeof performance !== "undefined" ? performance.now() : Date.now();
  const summary = spec.summarize(result, safeInput);
  store.finishAgentCall(replayId, result.ok, summary, Math.round(ended - started));
  // A one-sentence, human-readable line first, so an agent reading the JSON
  // as text sees the outcome before the structured fields.
  if (result.ok) return { ok: true, message: spec.message ? spec.message(result, safeInput, store) : summary, ...(result as object) } as ToolResult<unknown>;
  return { ok: false, message: `${result.error.code}: ${result.error.message}${result.error.hint ? ` ${result.error.hint}` : ""}`, error: result.error };
}
