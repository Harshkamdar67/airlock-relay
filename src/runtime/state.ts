// The single shared state both the human UI and the agent tools mutate.
// Every mutation is attributed to an actor and lands in the replay, so
// get_replay can show a judge exactly who did what.

import type {
  AgentCall,
  Actor,
  Handoff,
  HandoffResult,
  Preserve,
  RelayEvent,
  RelayState,
  ReplayEntry,
  Route,
  SessionState,
  ToolResult,
} from "./types";

export type Listener = (state: RelayState) => void;

export interface PrepareHandoffInput {
  target: string;
  reason: string;
  allow_metered?: boolean;
  preserve?: Partial<Preserve>;
}

export interface ExecuteHandoffInput {
  handoff_id: string;
  approval_token?: string;
}

export interface Clock {
  now(): Date;
}

const realClock: Clock = { now: () => new Date() };

function randomSuffix(): string {
  const bytes = new Uint8Array(6);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function shortModel(model: string): string {
  return model.replace(/\[1m\]$/, "");
}

export class RelayStore {
  private state: RelayState;
  private listeners = new Set<Listener>();
  private nextEventId: number;
  private nextReplayId: number;
  private nextCallId = 1;
  private pendingCalls = new Map<number, { tool: string; input: unknown; startedAt: string }>();
  readonly clock: Clock;

  constructor(initial: RelayState, clock: Clock = realClock) {
    this.state = initial;
    this.clock = clock;
    this.nextEventId = initial.events.reduce((m, e) => Math.max(m, e.id), 0) + 1;
    this.nextReplayId = initial.replay.reduce((m, e) => Math.max(m, e.id), 0) + 1;
  }

  get(): RelayState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Replace the whole state (used on reset and on live refresh). */
  replace(next: RelayState): void {
    this.state = next;
    this.nextEventId = next.events.reduce((m, e) => Math.max(m, e.id), 0) + 1;
    this.nextReplayId = next.replay.reduce((m, e) => Math.max(m, e.id), 0) + 1;
    this.emit();
  }

  /** Live mode: swap in fresh runtime facts while keeping the page-owned handoff and logs. */
  mergeRuntime(session: Partial<SessionState>, routes: Route[], events: RelayEvent[]): void {
    this.state = {
      ...this.state,
      session: { ...this.state.session, ...session },
      routes,
      events,
    };
    this.nextEventId = events.reduce((m, e) => Math.max(m, e.id), 0) + 1;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.state);
  }

  private now(): string {
    return this.clock.now().toISOString();
  }

  private set(patch: Partial<RelayState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private pushEvent(kind: string, summary: string, detail?: Record<string, unknown>): RelayEvent {
    const event: RelayEvent = { id: this.nextEventId++, at: this.now(), source: "relay", kind, summary, detail };
    this.state = { ...this.state, events: [...this.state.events, event] };
    return event;
  }

  private pushReplay(actor: Actor, action: string, detail?: string): ReplayEntry {
    const entry: ReplayEntry = { id: this.nextReplayId++, at: this.now(), actor, action, detail };
    this.state = { ...this.state, replay: [...this.state.replay, entry] };
    return entry;
  }

  // ---- Agent-facing mutations (called by the WebMCP tool handlers) ----

  /** Reserve the replay slot for an agent tool call before it runs, so runtime effects land after it. */
  beginAgentCall(tool: string, input: unknown): number {
    const entry = this.pushReplay("agent", tool);
    this.pendingCalls.set(entry.id, { tool, input, startedAt: this.now() });
    this.emit();
    return entry.id;
  }

  finishAgentCall(replayId: number, ok: boolean, summary: string, durationMs: number): void {
    const pending = this.pendingCalls.get(replayId);
    this.pendingCalls.delete(replayId);
    const call: AgentCall = { id: this.nextCallId++, at: pending?.startedAt ?? this.now(), tool: pending?.tool ?? "?", input: pending?.input, ok, summary, durationMs };
    const replay = this.state.replay.map((e) => (e.id === replayId ? { ...e, detail: summary } : e));
    this.state = { ...this.state, replay, agentCalls: [...this.state.agentCalls, call] };
    this.emit();
  }

  prepareHandoff(input: PrepareHandoffInput, createdBy: "agent" | "human" = "agent"): ToolResult<{ handoff: Handoff }> {
    const { session, routes } = this.state;
    const target = routes.find((r) => r.id === input.target || shortModel(r.id) === shortModel(input.target));
    if (!target) {
      return {
        ok: false,
        error: {
          code: "UNKNOWN_ROUTE",
          message: `No enabled route matches "${input.target}".`,
          hint: "Call get_routes and use one of the returned ids.",
          available: routes.filter((r) => r.status === "ready").map((r) => r.id),
        },
      };
    }
    if (shortModel(target.id) === shortModel(session.activeModel)) {
      return {
        ok: false,
        error: {
          code: "TARGET_IS_ACTIVE_MODEL",
          message: `${target.label} is already the active model.`,
          hint: "Choose a different route.",
        },
      };
    }
    if (target.status !== "ready") {
      return {
        ok: false,
        error: {
          code: "ROUTE_UNAVAILABLE",
          message: `${target.label} is ${target.status}${target.cooldownUntil ? ` until ${target.cooldownUntil}` : ""}.`,
          hint: "Pick a route whose status is ready.",
          available: routes.filter((r) => r.status === "ready").map((r) => r.id),
        },
      };
    }
    const allowMetered = Boolean(input.allow_metered);
    if (target.metered && !allowMetered) {
      const alternatives = routes.filter((r) => r.status === "ready" && !r.metered && shortModel(r.id) !== shortModel(session.activeModel));
      return {
        ok: false,
        error: {
          code: "METERED_ROUTE_REQUIRES_OPT_IN",
          message: `${target.label} spends metered extra usage. The proposal did not opt in to metered routes.`,
          hint: "Pick a non-metered route, or pass allow_metered: true only if the human said metered spend is acceptable.",
          non_metered_alternatives: alternatives.map((r) => ({ id: r.id, label: r.label, tier: r.tier })),
        },
      };
    }
    if (session.contextTokens > target.contextWindow) {
      const roomy = routes.filter((r) => r.status === "ready" && r.contextWindow >= session.contextTokens && shortModel(r.id) !== shortModel(session.activeModel));
      return {
        ok: false,
        error: {
          code: "CONTEXT_EXCEEDS_ROUTE_WINDOW",
          message: `The conversation is ${Math.round(session.contextTokens / 1000)}k tokens and ${target.label} accepts ${Math.round(target.contextWindow / 1000)}k.`,
          hint: "Pick a route whose context_window is at least the session's context_tokens, or ask the human whether compaction is acceptable.",
          context_tokens: session.contextTokens,
          routes_with_room: roomy.map((r) => ({ id: r.id, label: r.label, tier: r.tier, metered: r.metered, context_window: r.contextWindow })),
        },
      };
    }
    if (typeof input.reason !== "string" || input.reason.trim().length < 8) {
      return {
        ok: false,
        error: {
          code: "REASON_REQUIRED",
          message: "Give a short reason the human can read before approving.",
          hint: "One or two sentences explaining why this route and what is preserved.",
        },
      };
    }
    const previous = this.state.handoff;
    if (previous && (previous.status === "pending_approval" || previous.status === "approved")) {
      this.state = { ...this.state, handoff: { ...previous, status: "superseded", approvalToken: undefined } };
      this.pushReplay("relay", "handoff superseded", `${previous.id} replaced by a new proposal`);
    }
    const number = this.state.nextHandoffNumber;
    const handoff: Handoff = {
      id: `H-${number}`,
      from: session.activeModel,
      target: target.id,
      reason: input.reason.trim().slice(0, 400),
      allowMetered,
      preserve: { checkpoint: true, worktree: true, task: true, ...(input.preserve ?? {}) },
      note: "",
      status: "pending_approval",
      revision: 1,
      createdBy,
      createdAt: this.now(),
      humanChanges: [],
    };
    this.pushEvent("handoff_proposed", `${createdBy === "agent" ? "Agent" : "Human"} proposed ${handoff.id}: ${shortModel(handoff.from)} → ${shortModel(handoff.target)}`, { handoff_id: handoff.id });
    if (createdBy === "human") this.pushReplay("human", "proposed handoff", `${handoff.id} to ${target.label}`);
    this.set({ handoff, nextHandoffNumber: number + 1 });
    return { ok: true, handoff };
  }

  executeHandoff(input: ExecuteHandoffInput): ToolResult<{ handoff: Handoff; result: HandoffResult; already_executed: boolean }> {
    const handoff = this.state.handoff;
    if (!handoff || handoff.id !== input.handoff_id) {
      return {
        ok: false,
        error: {
          code: "HANDOFF_NOT_FOUND",
          message: `No handoff with id "${input.handoff_id}".`,
          hint: handoff ? `The current handoff is ${handoff.id}.` : "Call prepare_handoff first.",
        },
      };
    }
    if (handoff.status === "executed" && handoff.result) {
      return { ok: true, handoff, result: handoff.result, already_executed: true };
    }
    if (handoff.status === "superseded") {
      return { ok: false, error: { code: "HANDOFF_SUPERSEDED", message: `${handoff.id} was replaced by a newer proposal.`, hint: "Call get_handoff for the current one." } };
    }
    if (handoff.status === "rejected") {
      return { ok: false, error: { code: "HANDOFF_REJECTED", message: `The human rejected ${handoff.id}.`, hint: "Ask what they would prefer, then prepare a new handoff." } };
    }
    if (handoff.status === "pending_approval") {
      this.pushEvent("execute_refused", `Execution of ${handoff.id} refused: human approval required`, { handoff_id: handoff.id, revision: handoff.revision });
      this.pushReplay("relay", "refused execution", `${handoff.id} has no human approval yet`);
      this.emit();
      return {
        ok: false,
        error: {
          code: "APPROVAL_REQUIRED",
          message: `${handoff.id} has not been approved by the human.`,
          hint: "Ask the human to review the proposal in the Relay page and click Approve. Then call get_handoff to read the approval token.",
          revision: handoff.revision,
        },
      };
    }
    if (!input.approval_token || input.approval_token !== handoff.approvalToken) {
      this.pushEvent("execute_refused", `Execution of ${handoff.id} refused: approval token does not match revision ${handoff.revision}`, { handoff_id: handoff.id, revision: handoff.revision });
      this.pushReplay("relay", "refused execution", `${handoff.id} token stale or missing`);
      this.emit();
      return {
        ok: false,
        error: {
          code: "STALE_APPROVAL",
          message: `The approval token does not match revision ${handoff.revision} of ${handoff.id}.`,
          hint: "The human changed the proposal after you last read it. Call get_handoff, read the human_changes, and use the new approval_token.",
          revision: handoff.revision,
        },
      };
    }
    const target = this.state.routes.find((r) => r.id === handoff.target);
    if (!target || target.status !== "ready") {
      return { ok: false, error: { code: "ROUTE_UNAVAILABLE", message: `${handoff.target} is no longer ready.`, hint: "Prepare a new handoff." } };
    }
    const executedAt = this.now();
    const result: HandoffResult = {
      status: "resumed",
      previous: handoff.from,
      active: handoff.target,
      checkpoint: this.state.session.checkpoint,
      executedAt,
    };
    const executed: Handoff = { ...handoff, status: "executed", executedAt, result };
    const session: SessionState = {
      ...this.state.session,
      activeModel: target.id,
      activeProvider: target.provider,
      status: "running",
      blockedReason: undefined,
    };
    this.pushEvent("handoff_executed", `${handoff.id} executed: ${shortModel(handoff.from)} → ${shortModel(handoff.target)}${target.metered ? " (metered, human approved)" : ""}`, { handoff_id: handoff.id, revision: handoff.revision });
    this.pushEvent("session_resumed", `Session resumed on ${target.label} from checkpoint ${session.checkpoint}`, { checkpoint: session.checkpoint });
    this.pushReplay("runtime", "session resumed", `${target.label}, checkpoint ${session.checkpoint} preserved`);
    this.set({ handoff: executed, session });
    return { ok: true, handoff: executed, result, already_executed: false };
  }

  /** Demo mode: one simulated completed request on the active model, labelled scenario. */
  simulateRequest(): void {
    const { session, routes } = this.state;
    if (session.status !== "running") return;
    const route = routes.find((r) => shortModel(r.id) === shortModel(session.activeModel));
    const outputTokens = 400 + Math.floor(Math.random() * 1800);
    const durationMs = 2200 + Math.floor(Math.random() * 9000);
    const event: RelayEvent = {
      id: this.nextEventId++,
      at: this.now(),
      source: "scenario",
      kind: "request_completed",
      summary: `${shortModel(session.activeModel)} completed in ${(durationMs / 1000).toFixed(1)}s, ${(session.contextTokens / 1000).toFixed(1)}k in / ${outputTokens} out`,
      detail: { provider: route?.provider, model: session.activeModel, status: 200, outcome: "completed", duration_ms: durationMs },
    };
    this.state = { ...this.state, events: [...this.state.events, event], session: { ...session, contextTokens: session.contextTokens + Math.floor(outputTokens * 0.7) } };
    this.emit();
  }

  /** Re-emit without changes so time-based UI (countdowns) can refresh. */
  touch(): void {
    this.emit();
  }

  /** Live mode: record what the local bridge did with an approved handoff. */
  recordBridgeResult(summary: string, detail?: Record<string, unknown>): void {
    this.pushEvent("bridge_result", summary, detail);
    this.pushReplay("relay", "bridge applied handoff", summary);
    this.emit();
  }

  // ---- Human-facing mutations (called by the UI only; there is no WebMCP tool for these) ----

  private editable(): Handoff | null {
    const h = this.state.handoff;
    if (!h) return null;
    if (h.status === "executed" || h.status === "superseded" || h.status === "rejected") return null;
    return h;
  }

  humanSetTarget(targetId: string): boolean {
    const h = this.editable();
    const target = this.state.routes.find((r) => r.id === targetId);
    if (!h || !target || target.status !== "ready" || target.id === h.target) return false;
    if (target.contextWindow < this.state.session.contextTokens) return false;
    const revision = h.revision + 1;
    const note = target.metered && !h.allowMetered ? "Human chose a metered route; that overrides the proposal's allow_metered=false." : undefined;
    const next: Handoff = {
      ...h,
      target: target.id,
      revision,
      status: "pending_approval",
      approvalToken: undefined,
      approvedAt: undefined,
      humanChanges: [...h.humanChanges, { at: this.now(), field: "target", from: h.target, to: target.id, revision, note }],
    };
    this.pushEvent("handoff_edited", `Human changed ${h.id} target to ${target.label} (revision ${revision})`, { handoff_id: h.id, revision });
    this.pushReplay("human", "changed target", `${h.id}: ${shortModel(h.target)} → ${shortModel(target.id)}`);
    this.set({ handoff: next });
    return true;
  }

  humanSetPreserve(key: keyof Preserve, value: boolean): boolean {
    const h = this.editable();
    if (!h || h.preserve[key] === value) return false;
    const revision = h.revision + 1;
    const next: Handoff = {
      ...h,
      preserve: { ...h.preserve, [key]: value },
      revision,
      status: "pending_approval",
      approvalToken: undefined,
      approvedAt: undefined,
      humanChanges: [...h.humanChanges, { at: this.now(), field: "preserve", from: { [key]: h.preserve[key] }, to: { [key]: value }, revision }],
    };
    this.pushEvent("handoff_edited", `Human set preserve.${key} = ${value} on ${h.id} (revision ${revision})`, { handoff_id: h.id, revision });
    this.pushReplay("human", "edited preserve", `${h.id}: ${key} ${value ? "on" : "off"}`);
    this.set({ handoff: next });
    return true;
  }

  humanSetNote(note: string): boolean {
    const h = this.editable();
    if (!h || h.note === note) return false;
    const revision = h.revision + 1;
    const next: Handoff = {
      ...h,
      note: note.slice(0, 280),
      revision,
      status: "pending_approval",
      approvalToken: undefined,
      approvedAt: undefined,
      humanChanges: [...h.humanChanges, { at: this.now(), field: "note", from: h.note, to: note.slice(0, 280), revision }],
    };
    this.pushReplay("human", "added note", `${h.id}: "${note.slice(0, 60)}"`);
    this.set({ handoff: next });
    return true;
  }

  humanApprove(): boolean {
    const h = this.editable();
    if (!h || h.status === "approved") return false;
    const token = `apr_${h.id}_r${h.revision}_${randomSuffix()}`;
    const next: Handoff = {
      ...h,
      status: "approved",
      approvedAt: this.now(),
      approvalToken: token,
      humanChanges: [...h.humanChanges, { at: this.now(), field: "approval", to: `revision ${h.revision}`, revision: h.revision }],
    };
    this.pushEvent("handoff_approved", `Human approved ${h.id} at revision ${h.revision}`, { handoff_id: h.id, revision: h.revision });
    this.pushReplay("human", "approved handoff", `${h.id} revision ${h.revision}`);
    this.set({ handoff: next });
    return true;
  }

  humanReject(): boolean {
    const h = this.editable();
    if (!h) return false;
    const next: Handoff = {
      ...h,
      status: "rejected",
      approvalToken: undefined,
      humanChanges: [...h.humanChanges, { at: this.now(), field: "rejection", revision: h.revision }],
    };
    this.pushEvent("handoff_rejected", `Human rejected ${h.id}`, { handoff_id: h.id });
    this.pushReplay("human", "rejected handoff", h.id);
    this.set({ handoff: next });
    return true;
  }
}
