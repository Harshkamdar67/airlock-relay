// Turns an Airlock router diagnostics report into Relay events and route
// availability. The report shape is the one served by the router's GET
// /diagnostics endpoint. The same adapter runs on the demo fixture and on
// live data from the local bridge, so the page never has two code paths.

import type { EventSource, Provider, RelayEvent, Route, RouteStatus } from "./types";

export interface AirlockRequestEvent {
  provider: string;
  model: string;
  status: number;
  request_bytes?: number;
  response_bytes?: number;
  duration_ms?: number;
  outcome: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  timestamp: string;
  /** Present only in fixtures, to label what was copied from a real session. */
  source?: EventSource;
}

export interface AirlockActionEvent {
  kind: string;
  timestamp: string;
  source?: EventSource;
  /** Ingested runtimes may send a ready-made summary. */
  summary?: string;
  [key: string]: unknown;
}

export type AirlockEvent = AirlockRequestEvent | AirlockActionEvent;

export interface AirlockDiagnostics {
  instance_id: string;
  profile: string;
  root_model: string;
  root_provider: string;
  rate_limit_cooldowns: string[];
  rate_limit_provider_cooldowns: string[];
  events: AirlockEvent[];
  summary: Array<Record<string, unknown>>;
}

export function isActionEvent(event: AirlockEvent): event is AirlockActionEvent {
  return typeof (event as AirlockActionEvent).kind === "string";
}

function shortModel(model: string): string {
  return model.replace(/\[1m\]$/, "");
}

function fmtTokens(n: number | undefined): string {
  if (n === undefined) return "?";
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k`;
  return String(n);
}

/** One-line human summary for a router event. Kept short: tool results are bounded. */
export function summarizeAirlockEvent(event: AirlockEvent): string {
  if (!isActionEvent(event)) {
    const usage = event.usage ?? {};
    const inTok = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    if (event.status >= 200 && event.status < 300) {
      return `${shortModel(event.model)} completed in ${((event.duration_ms ?? 0) / 1000).toFixed(1)}s, ${fmtTokens(inTok)} in / ${fmtTokens(usage.output_tokens)} out`;
    }
    return `${shortModel(event.model)} returned ${event.status} (${event.outcome})`;
  }
  const e = event;
  if (typeof e.summary === "string" && e.summary.trim()) return e.summary.slice(0, 200);
  const m = (k: string) => shortModel(String(e[k] ?? "?"));
  switch (e.kind) {
    case "session_model_pinned":
      return `Session pinned to ${m("model")} on ${e.provider}`;
    case "rate_limit_provider_cooldown":
      return `${e.provider} pool exhausted after ${m("model")} was rate limited; provider on cooldown`;
    case "rate_limit_cooldown_skipped":
      return `${m("model")} skipped, still on cooldown`;
    case "rate_limit_failover_attempted":
      return `Rate limit: trying ${m("to_model")} in place of ${m("from_model")}`;
    case "rate_limit_failover_succeeded":
      return `Rate limit failover succeeded: ${m("from_model")} → ${m("to_model")} (${e.hops} hops)`;
    case "rate_limit_chain_exhausted":
      return `Every peer of ${m("model")} is rate limited (${e.models_considered} considered)` + (e.retry_after ? `, retry after ${e.retry_after}s` : "");
    case "upstream_context_overflow":
      return `${m("model")} rejected the context (${fmtTokens(e.prompt_tokens as number)} > ${fmtTokens(e.limit_tokens as number)})`;
    case "failover_overflow_attempted":
      return `Context overflow: trying ${m("to_model")} in place of ${m("from_model")}`;
    case "failover_overflow_succeeded":
      return `Overflow failover succeeded: ${m("from_model")} → ${m("to_model")}`;
    case "failover_shrink_compacted":
      return `Conversation compacted for ${m("to_model")}`;
    case "background_model_substituted":
      return `Background request moved to ${m("model")}`;
    case "router_restarted":
      return "Router restarted";
    default:
      return e.kind.replace(/_/g, " ");
  }
}

export function airlockEventsToRelay(events: AirlockEvent[], startId = 1): RelayEvent[] {
  return events.map((event, index) => {
    const detail: Record<string, unknown> = { ...event };
    delete detail.source;
    delete detail.summary;
    return {
      id: startId + index,
      at: event.timestamp,
      source: event.source ?? "airlock",
      kind: isActionEvent(event) ? event.kind : `request_${event.outcome}`,
      summary: summarizeAirlockEvent(event),
      detail,
    };
  });
}

/** Static knowledge about routes Airlock can serve. Only the availability part is live. */
export interface RouteCatalogEntry {
  id: string;
  label: string;
  provider: Provider;
  tier: Route["tier"];
  metered: boolean;
  contextWindow: number;
}

export const ROUTE_CATALOG: RouteCatalogEntry[] = [
  { id: "claude-opus-5[1m]", label: "Claude Opus 5", provider: "anthropic", tier: "frontier", metered: false, contextWindow: 1_000_000 },
  { id: "claude-sonnet-5[1m]", label: "Claude Sonnet 5", provider: "anthropic", tier: "general", metered: false, contextWindow: 1_000_000 },
  { id: "claude-fable-5-1[1m]", label: "Claude Fable 5.1", provider: "anthropic", tier: "frontier", metered: true, contextWindow: 1_000_000 },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", provider: "anthropic", tier: "utility", metered: false, contextWindow: 200_000 },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", provider: "openai", tier: "frontier", metered: false, contextWindow: 400_000 },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", provider: "openai", tier: "general", metered: false, contextWindow: 400_000 },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", provider: "openai", tier: "utility", metered: false, contextWindow: 400_000 },
  { id: "grok-4.6", label: "Grok 4.6", provider: "grok", tier: "frontier", metered: false, contextWindow: 2_000_000 },
  { id: "grok-composer-2.5-fast", label: "Grok Composer 2.5 Fast", provider: "grok", tier: "general", metered: false, contextWindow: 1_000_000 },
];

export function catalogEntry(id: string): RouteCatalogEntry | undefined {
  return ROUTE_CATALOG.find((r) => r.id === id || r.id === `${id}[1m]` || `${r.id}` === shortModel(id));
}

/**
 * Compute route availability from the router's cooldown lists and enabled
 * model ids. Metered routes are exempt from a plan-level provider cooldown
 * because extra usage is a separate meter; that mirrors how Airlock treats
 * the fable route on an Anthropic plan.
 */
export function routesFromDiagnostics(
  diag: Pick<AirlockDiagnostics, "rate_limit_cooldowns" | "rate_limit_provider_cooldowns">,
  enabledModels: string[],
  cooldownUntil?: string,
): Route[] {
  const enabled = new Set(enabledModels.map(shortModel));
  return ROUTE_CATALOG.filter((entry) => enabled.has(shortModel(entry.id))).map((entry) => {
    let status: RouteStatus = "ready";
    const modelCooling = diag.rate_limit_cooldowns.map(shortModel).includes(shortModel(entry.id));
    const providerCooling = diag.rate_limit_provider_cooldowns.includes(entry.provider) && !entry.metered;
    if (modelCooling || providerCooling) status = "cooldown";
    const route: Route = { ...entry, status };
    if (status === "cooldown" && cooldownUntil) route.cooldownUntil = cooldownUntil;
    return route;
  });
}
