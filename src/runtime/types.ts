// Shared state that the human UI and the WebMCP tools both operate on.
// Nothing here is UI-specific and nothing here is agent-specific.

export type Provider = "anthropic" | "openai" | "grok" | "openrouter";

export type RouteTier = "frontier" | "general" | "utility";

export type RouteStatus = "ready" | "cooldown" | "disabled";

/** Plan usage for a provider, the way Airlock's status line reads it. */
export interface Headroom {
  /** "5h", "7d", or "credits". */
  window: string;
  usedPercent: number;
  resetsAt: string;
}

export type Scenario = "rate_limit" | "context_overflow";

export interface Route {
  /** Exact model id as Airlock's router knows it. */
  id: string;
  /** Human label, e.g. "Claude Opus 5". */
  label: string;
  provider: Provider;
  tier: RouteTier;
  /** True when using this route spends extra, metered usage beyond the plan. */
  metered: boolean;
  status: RouteStatus;
  /** ISO timestamp, only present while status is "cooldown". */
  cooldownUntil?: string;
  contextWindow: number;
  headroom?: Headroom;
}

export type SessionStatus = "running" | "blocked" | "resuming";

export type BlockedReason = "rate_limit" | "context_overflow" | "provider_error";

export interface SessionState {
  id: string;
  task: string;
  profile: string;
  activeModel: string;
  activeProvider: Provider;
  status: SessionStatus;
  blockedReason?: BlockedReason;
  contextTokens: number;
  checkpoint: string;
  workdir: string;
  startedAt: string;
}

export type EventSource = "airlock" | "scenario" | "relay";

export interface RelayEvent {
  id: number;
  at: string;
  /** airlock = copied from a real router report, scenario = seeded for the demo, relay = produced by this page. */
  source: EventSource;
  kind: string;
  summary: string;
  detail?: Record<string, unknown>;
}

export type HandoffStatus =
  | "pending_approval"
  | "approved"
  | "rejected"
  | "executed"
  | "superseded";

export interface Preserve {
  checkpoint: boolean;
  worktree: boolean;
  task: boolean;
}

export interface HumanChange {
  at: string;
  field: "target" | "preserve" | "note" | "approval" | "rejection";
  from?: unknown;
  to?: unknown;
  /** Revision number after this change was applied. */
  revision: number;
  note?: string;
}

export interface HandoffResult {
  status: "resumed";
  previous: string;
  active: string;
  checkpoint: string;
  executedAt: string;
}

export interface Handoff {
  id: string;
  from: string;
  target: string;
  reason: string;
  allowMetered: boolean;
  preserve: Preserve;
  note: string;
  status: HandoffStatus;
  revision: number;
  createdBy: "agent" | "human";
  createdAt: string;
  approvedAt?: string;
  /** Issued on approval, bound to the revision approved. Cleared on any later change. */
  approvalToken?: string;
  humanChanges: HumanChange[];
  executedAt?: string;
  result?: HandoffResult;
}

export type Actor = "runtime" | "agent" | "human" | "relay";

export interface ReplayEntry {
  id: number;
  at: string;
  actor: Actor;
  action: string;
  detail?: string;
}

export interface AgentCall {
  id: number;
  at: string;
  tool: string;
  input: unknown;
  ok: boolean;
  summary: string;
  durationMs: number;
}

export type RelayMode = "demo" | "live";

export interface RelayState {
  mode: RelayMode;
  scenario: Scenario;
  session: SessionState;
  routes: Route[];
  events: RelayEvent[];
  handoff: Handoff | null;
  replay: ReplayEntry[];
  agentCalls: AgentCall[];
  /** Counter for handoff ids so they stay stable across resets within a page. */
  nextHandoffNumber: number;
}

export interface ToolError {
  code: string;
  message: string;
  hint?: string;
  [key: string]: unknown;
}

export type ToolResult<T> =
  | ({ ok: true } & T)
  | { ok: false; error: ToolError };
