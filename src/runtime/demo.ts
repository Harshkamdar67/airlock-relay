// Builds the deterministic demo session judges start from. The router
// report comes from fixtures/airlock-diagnostics-2026-09-03.json and goes
// through the same adapter live data does.

import fixture from "../../fixtures/airlock-diagnostics-2026-09-03.json";
import { airlockEventsToRelay, routesFromDiagnostics, type AirlockDiagnostics } from "./airlock-adapter";
import type { RelayState, ReplayEntry } from "./types";

const ENABLED_MODELS = [
  "claude-opus-5[1m]",
  "claude-sonnet-5[1m]",
  "claude-fable-5-1[1m]",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "grok-4.6",
  "grok-composer-2.5-fast",
];

export const DEMO_TASK = "Refactor the authentication middleware in ledger-api and move session tokens to signed cookies";

export function buildDemoState(now: Date = new Date()): RelayState {
  const diag = fixture as unknown as AirlockDiagnostics;
  const events = airlockEventsToRelay(diag.events);
  const cooldownUntil = new Date(now.getTime() + 14 * 60 * 1000).toISOString();
  const routes = routesFromDiagnostics(diag, ENABLED_MODELS, cooldownUntil);
  const lastEvent = events[events.length - 1];
  const replay: ReplayEntry[] = [
    { id: 1, at: events[0]?.at ?? now.toISOString(), actor: "runtime", action: "session started", detail: "Claude Opus 5 pinned as orchestrator" },
    { id: 2, at: lastEvent?.at ?? now.toISOString(), actor: "runtime", action: "session blocked", detail: "Anthropic plan rate limited; every peer on cooldown" },
  ];
  return {
    mode: "demo",
    session: {
      id: "sess_9f2c",
      task: DEMO_TASK,
      profile: diag.profile,
      activeModel: diag.root_model,
      activeProvider: diag.root_provider as RelayState["session"]["activeProvider"],
      status: "blocked",
      blockedReason: "rate_limit",
      contextTokens: 118_420,
      checkpoint: "cp_184",
      workdir: "~/work/ledger-api",
      startedAt: events[0]?.at ?? now.toISOString(),
    },
    routes,
    events,
    handoff: null,
    replay,
    agentCalls: [],
    nextHandoffNumber: 229,
  };
}
