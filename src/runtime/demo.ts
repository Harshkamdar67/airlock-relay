// Builds the deterministic demo sessions judges start from. Each scenario is
// an Airlock router diagnostics report (see fixtures/) run through the same
// adapter live data uses, plus the session-card fields that are invented for
// the demo (task, id, checkpoint, worktree) and the per-provider plan headroom.

import rateLimitFixture from "../../fixtures/airlock-diagnostics-2026-09-03.json";
import overflowFixture from "../../fixtures/airlock-diagnostics-overflow.json";
import { airlockEventsToRelay, routesFromDiagnostics, type AirlockDiagnostics } from "./airlock-adapter";
import type { Headroom, Provider, RelayState, ReplayEntry, Scenario } from "./types";

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

export interface ScenarioInfo {
  id: Scenario;
  title: string;
  blurb: string;
}

export const SCENARIOS: ScenarioInfo[] = [
  { id: "rate_limit", title: "Rate limit", blurb: "Anthropic plan exhausted mid-refactor. Every Claude route except metered Fable is on cooldown." },
  { id: "context_overflow", title: "Context overflow", blurb: "A GPT-5.6 Sol session outgrew its 400k window. The next route needs room for 412k tokens." },
];

function minutesFrom(now: Date, minutes: number): string {
  return new Date(now.getTime() + minutes * 60 * 1000).toISOString();
}

function headroomFor(scenario: Scenario, now: Date): Record<Provider, Headroom> {
  if (scenario === "rate_limit") {
    return {
      anthropic: { window: "5h", usedPercent: 100, resetsAt: minutesFrom(now, 14) },
      openai: { window: "5h", usedPercent: 38, resetsAt: minutesFrom(now, 171) },
      grok: { window: "5h", usedPercent: 100, resetsAt: minutesFrom(now, 41) },
      openrouter: { window: "credits", usedPercent: 12, resetsAt: minutesFrom(now, 0) },
    };
  }
  return {
    anthropic: { window: "5h", usedPercent: 62, resetsAt: minutesFrom(now, 93) },
    openai: { window: "5h", usedPercent: 44, resetsAt: minutesFrom(now, 130) },
    grok: { window: "5h", usedPercent: 12, resetsAt: minutesFrom(now, 224) },
    openrouter: { window: "credits", usedPercent: 12, resetsAt: minutesFrom(now, 0) },
  };
}

export function buildDemoState(now: Date = new Date(), scenario: Scenario = "rate_limit"): RelayState {
  const diag = (scenario === "rate_limit" ? rateLimitFixture : overflowFixture) as unknown as AirlockDiagnostics;
  const events = airlockEventsToRelay(diag.events);
  const headroom = headroomFor(scenario, now);
  const cooldownUntil = scenario === "rate_limit" ? minutesFrom(now, 14) : undefined;
  const routes = routesFromDiagnostics(diag, ENABLED_MODELS, cooldownUntil).map((route) => {
    const h = headroom[route.provider];
    const withHeadroom = { ...route, headroom: h };
    if (route.id === "grok-4.6" && scenario === "rate_limit") return { ...withHeadroom, cooldownUntil: minutesFrom(now, 41) };
    return withHeadroom;
  });
  const first = events[0]?.at ?? now.toISOString();
  const last = events[events.length - 1]?.at ?? now.toISOString();
  const replay: ReplayEntry[] =
    scenario === "rate_limit"
      ? [
          { id: 1, at: first, actor: "runtime", action: "session started", detail: "Claude Opus 5 pinned as orchestrator" },
          { id: 2, at: last, actor: "runtime", action: "session blocked", detail: "Anthropic plan rate limited; every peer on cooldown" },
        ]
      : [
          { id: 1, at: first, actor: "runtime", action: "session started", detail: "GPT-5.6 Sol pinned as orchestrator" },
          { id: 2, at: last, actor: "runtime", action: "session blocked", detail: "412k-token conversation exceeds the 400k window; compaction refused" },
        ];
  const session: RelayState["session"] =
    scenario === "rate_limit"
      ? {
          id: "sess_9f2c",
          task: "Refactor the authentication middleware in ledger-api and move session tokens to signed cookies",
          profile: diag.profile,
          activeModel: diag.root_model,
          activeProvider: diag.root_provider as Provider,
          status: "blocked",
          blockedReason: "rate_limit",
          contextTokens: 118_420,
          checkpoint: "cp_184",
          workdir: "~/work/ledger-api",
          startedAt: first,
        }
      : {
          id: "sess_41ab",
          task: "Migrate the billing service from REST to gRPC, keeping the public API compatible",
          profile: diag.profile,
          activeModel: diag.root_model,
          activeProvider: diag.root_provider as Provider,
          status: "blocked",
          blockedReason: "context_overflow",
          contextTokens: 412_300,
          checkpoint: "cp_311",
          workdir: "~/work/billing-svc",
          startedAt: first,
        };
  return {
    mode: "demo",
    scenario,
    session,
    routes,
    events,
    handoff: null,
    replay,
    agentCalls: [],
    nextHandoffNumber: scenario === "rate_limit" ? 229 : 412,
  };
}
