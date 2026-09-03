// Live mode. The local bridge (bridge/relay.py) serves this build and a
// same-origin state endpoint fed by the real Airlock router's /diagnostics.
// The page keeps owning the handoff proposal; only runtime facts are live.

import { airlockEventsToRelay, routesFromDiagnostics, type AirlockDiagnostics } from "./airlock-adapter";
import type { RelayStore } from "./state";
import type { RelayState } from "./types";

export interface BridgeState {
  bridge: { version: string; router_url: string; ready: boolean; session_id?: string | null; resume_command?: string | null; resume_status?: string | null };
  session: {
    id: string;
    task: string;
    workdir: string;
    checkpoint: string;
    context_tokens: number;
    started_at: string;
  };
  enabled_models: string[];
  cooldown_until?: string;
  diagnostics: AirlockDiagnostics;
}

const STATE_URL = "./relay/api/state";

async function fetchBridge(): Promise<BridgeState | null> {
  try {
    const response = await fetch(STATE_URL, { cache: "no-store" });
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) return null;
    return (await response.json()) as BridgeState;
  } catch {
    return null;
  }
}

export function applyBridgeState(store: RelayStore, bridge: BridgeState): void {
  const d = bridge.diagnostics;
  const events = airlockEventsToRelay(d.events);
  const routes = routesFromDiagnostics(d, bridge.enabled_models, bridge.cooldown_until);
  const rootCooling =
    d.rate_limit_cooldowns.some((m) => m.replace(/\[1m\]$/, "") === d.root_model.replace(/\[1m\]$/, "")) ||
    d.rate_limit_provider_cooldowns.includes(d.root_provider);
  const current = store.get();
  const handoffExecuted = current.handoff?.status === "executed";
  const session: Partial<RelayState["session"]> = {
    id: bridge.session.id,
    task: bridge.session.task,
    profile: d.profile,
    workdir: bridge.session.workdir,
    checkpoint: bridge.session.checkpoint,
    contextTokens: bridge.session.context_tokens,
    startedAt: bridge.session.started_at,
  };
  if (!handoffExecuted) {
    session.activeModel = d.root_model;
    session.activeProvider = d.root_provider as RelayState["session"]["activeProvider"];
    session.status = rootCooling ? "blocked" : "running";
    session.blockedReason = rootCooling ? "rate_limit" : undefined;
  }
  // Keep relay-produced events (proposals, approvals) after the live ones.
  const relayEvents = current.events.filter((e) => e.source === "relay");
  const merged = [...events, ...relayEvents.map((e, i) => ({ ...e, id: events.length + i + 1 }))];
  store.mergeRuntime(session, routes, merged, {
    routerUrl: bridge.bridge.router_url,
    sessionId: bridge.bridge.session_id ?? null,
    resumeCommand: bridge.bridge.resume_command ?? current.bridge?.resumeCommand ?? null,
    resumeStatus: bridge.bridge.resume_status ?? current.bridge?.resumeStatus ?? null,
  });
}

export async function connectLive(store: RelayStore, intervalMs = 2500): Promise<boolean> {
  const first = await fetchBridge();
  if (!first) return false;
  const base = store.get();
  store.replace({ ...base, mode: "live", handoff: null, agentCalls: [], replay: [{ id: 1, at: new Date().toISOString(), actor: "relay", action: "connected to live Airlock router", detail: first.bridge.router_url }] });
  applyBridgeState(store, first);
  const tick = async () => {
    const next = await fetchBridge();
    if (next) applyBridgeState(store, next);
  };
  setInterval(() => void tick(), intervalMs);
  return true;
}
