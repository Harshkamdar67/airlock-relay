import { describe, expect, it, beforeEach } from "vitest";
import { RelayStore } from "../src/runtime/state";
import { buildDemoState } from "../src/runtime/demo";
import { invokeTool, TOOLS, MAX_EVENTS } from "../src/webmcp/tools";

function fixedClock() {
  let t = new Date("2026-09-03T07:00:00Z").getTime();
  return { now: () => new Date((t += 1000)) };
}

function store() {
  return new RelayStore(buildDemoState(new Date("2026-09-03T07:00:00Z")), fixedClock());
}

function call<T = any>(s: RelayStore, name: string, input: unknown = {}): T {
  return invokeTool(s, name, input) as T;
}

describe("demo session", () => {
  it("starts blocked on Opus with anthropic plan routes on cooldown and fable ready because it is metered", () => {
    const s = store();
    const r = call(s, "get_session");
    expect(r.ok).toBe(true);
    expect(r.session.status).toBe("blocked");
    expect(r.session.blocked_reason).toBe("rate_limit");
    const routes = call(s, "get_routes").routes as Array<{ id: string; status: string; metered: boolean }>;
    const byId = Object.fromEntries(routes.map((x) => [x.id, x]));
    expect(byId["claude-opus-5[1m]"].status).toBe("cooldown");
    expect(byId["claude-sonnet-5[1m]"].status).toBe("cooldown");
    expect(byId["claude-fable-5-1[1m]"].status).toBe("ready");
    expect(byId["claude-fable-5-1[1m]"].metered).toBe(true);
    expect(byId["gpt-5.6-sol"].status).toBe("ready");
    expect(byId["grok-4.6"].status).toBe("cooldown");
  });

  it("labels every event with its source so judges can tell real from seeded", () => {
    const s = store();
    const events = call(s, "get_events").events as Array<{ source: string; kind: string }>;
    expect(events.some((e) => e.source === "airlock")).toBe(true);
    expect(events.some((e) => e.source === "scenario" && e.kind === "rate_limit_chain_exhausted")).toBe(true);
    expect(events.every((e) => ["airlock", "scenario", "relay"].includes(e.source))).toBe(true);
  });

  it("bounds get_events and supports since_id", () => {
    const s = store();
    const all = call(s, "get_events");
    expect(all.events.length).toBeLessThanOrEqual(MAX_EVENTS);
    const lastId = all.events[all.events.length - 1].id;
    const none = call(s, "get_events", { since_id: lastId });
    expect(none.events).toHaveLength(0);
    const two = call(s, "get_events", { limit: 2 });
    expect(two.events).toHaveLength(2);
    expect(two.truncated).toBe(true);
  });
});

describe("prepare_handoff policy", () => {
  it("refuses a metered route unless allow_metered is true and lists alternatives", () => {
    const s = store();
    const r = call(s, "prepare_handoff", { target: "claude-fable-5-1[1m]", reason: "Stay on Claude for continuity." });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("METERED_ROUTE_REQUIRES_OPT_IN");
    expect(r.error.non_metered_alternatives.map((x: any) => x.id)).toContain("gpt-5.6-sol");
    expect(s.get().handoff).toBeNull();
  });

  it("refuses routes on cooldown and unknown routes", () => {
    const s = store();
    expect(call(s, "prepare_handoff", { target: "grok-4.6", reason: "Large context window." }).error.code).toBe("ROUTE_UNAVAILABLE");
    expect(call(s, "prepare_handoff", { target: "gpt-9", reason: "Does not exist." }).error.code).toBe("UNKNOWN_ROUTE");
    expect(call(s, "prepare_handoff", { target: "gpt-5.6-sol", reason: "x" }).error.code).toBe("REASON_REQUIRED");
  });

  it("creates a pending proposal without switching the session", () => {
    const s = store();
    const r = call(s, "prepare_handoff", { target: "gpt-5.6-sol", reason: "Sol is ready, frontier tier, and not metered." });
    expect(r.ok).toBe(true);
    expect(r.handoff.id).toBe("H-229");
    expect(r.handoff.status).toBe("pending_approval");
    expect(r.handoff.revision).toBe(1);
    expect(r.handoff.approval_token).toBeUndefined();
    expect(s.get().session.status).toBe("blocked");
    expect(s.get().session.activeModel).toBe("claude-opus-5[1m]");
  });

  it("supersedes an earlier pending proposal", () => {
    const s = store();
    call(s, "prepare_handoff", { target: "gpt-5.6-sol", reason: "First proposal for the session." });
    const second = call(s, "prepare_handoff", { target: "gpt-5.6-terra", reason: "Second proposal for the session." });
    expect(second.handoff.id).toBe("H-230");
    expect(call(s, "execute_handoff", { handoff_id: "H-229" }).error.code).toBe("HANDOFF_NOT_FOUND");
  });
});

describe("approval enforcement", () => {
  let s: RelayStore;
  beforeEach(() => {
    s = store();
    call(s, "prepare_handoff", { target: "gpt-5.6-sol", reason: "Sol is ready, frontier tier, and not metered." });
  });

  it("agent cannot execute an unapproved handoff", () => {
    const r = call(s, "execute_handoff", { handoff_id: "H-229" });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("APPROVAL_REQUIRED");
    expect(s.get().session.status).toBe("blocked");
    expect(s.get().events.at(-1)?.kind).toBe("execute_refused");
  });

  it("get_handoff exposes the approval token only after the human approves", () => {
    expect(call(s, "get_handoff").handoff.approval_token).toBeUndefined();
    expect(s.humanApprove()).toBe(true);
    const h = call(s, "get_handoff").handoff;
    expect(h.status).toBe("approved");
    expect(h.approval_token).toMatch(/^apr_H-229_r1_/);
  });

  it("human edit is visible to the agent and invalidates the earlier approval", () => {
    s.humanApprove();
    const token = call(s, "get_handoff").handoff.approval_token as string;
    expect(s.humanSetTarget("claude-fable-5-1[1m]")).toBe(true);
    const h = call(s, "get_handoff").handoff;
    expect(h.status).toBe("pending_approval");
    expect(h.revision).toBe(2);
    expect(h.target).toBe("claude-fable-5-1[1m]");
    expect(h.humanChanges.at(-1).field).toBe("target");
    expect(h.humanChanges.at(-1).note).toMatch(/metered/);
    const stale = call(s, "execute_handoff", { handoff_id: "H-229", approval_token: token });
    expect(stale.error.code).toBe("APPROVAL_REQUIRED");
    s.humanApprove();
    const wrongToken = call(s, "execute_handoff", { handoff_id: "H-229", approval_token: token });
    expect(wrongToken.error.code).toBe("STALE_APPROVAL");
  });

  it("human cannot pick a route that is on cooldown", () => {
    expect(s.humanSetTarget("grok-4.6")).toBe(false);
    expect(s.get().handoff?.revision).toBe(1);
  });

  it("executes exactly once with the current token and resumes the session", () => {
    s.humanSetTarget("claude-fable-5-1[1m]");
    s.humanApprove();
    const token = call(s, "get_handoff").handoff.approval_token as string;
    const r = call(s, "execute_handoff", { handoff_id: "H-229", approval_token: token });
    expect(r.ok).toBe(true);
    expect(r.already_executed).toBe(false);
    expect(r.result.status).toBe("resumed");
    expect(r.result.previous).toBe("claude-opus-5[1m]");
    expect(r.result.active).toBe("claude-fable-5-1[1m]");
    expect(r.result.checkpoint).toBe("cp_184");
    const session = call(s, "get_session").session;
    expect(session.status).toBe("running");
    expect(session.active_model).toBe("claude-fable-5-1[1m]");
    expect(session.blocked_reason).toBeNull();
    const again = call(s, "execute_handoff", { handoff_id: "H-229", approval_token: token });
    expect(again.ok).toBe(true);
    expect(again.already_executed).toBe(true);
    expect(s.get().events.filter((e) => e.kind === "handoff_executed")).toHaveLength(1);
  });

  it("rejected handoffs cannot be executed or edited", () => {
    s.humanReject();
    expect(call(s, "execute_handoff", { handoff_id: "H-229" }).error.code).toBe("HANDOFF_REJECTED");
    expect(s.humanSetTarget("gpt-5.6-terra")).toBe(false);
    expect(s.humanApprove()).toBe(false);
  });
});

describe("replay and attribution", () => {
  it("records runtime, agent, and human actors in order", () => {
    const s = store();
    call(s, "get_session");
    call(s, "prepare_handoff", { target: "gpt-5.6-sol", reason: "Sol is ready, frontier tier, and not metered." });
    s.humanSetTarget("gpt-5.6-terra");
    s.humanApprove();
    const token = call(s, "get_handoff").handoff.approval_token as string;
    call(s, "execute_handoff", { handoff_id: "H-229", approval_token: token });
    const replay = call(s, "get_replay").replay as Array<{ actor: string; action: string }>;
    const actors = replay.map((e) => e.actor);
    expect(actors[0]).toBe("runtime");
    expect(actors).toContain("agent");
    expect(actors).toContain("human");
    expect(replay.at(-1)?.action).toBe("get_replay");
    expect(replay.at(-2)?.action).toBe("session resumed");
    expect(replay.filter((e) => e.action === "execute_handoff")).toHaveLength(1);
    const humanIdx = replay.findIndex((e) => e.action === "changed target");
    const execIdx = replay.findIndex((e) => e.action === "execute_handoff");
    expect(humanIdx).toBeGreaterThan(-1);
    expect(execIdx).toBeGreaterThan(humanIdx);
  });
});

describe("tool surface", () => {
  it("exposes exactly seven tools with read-only annotations on reads and no approve tool", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toEqual(["get_session", "get_events", "get_routes", "prepare_handoff", "get_handoff", "execute_handoff", "get_replay"]);
    expect(names.some((n) => n.includes("approve"))).toBe(false);
    for (const t of TOOLS) {
      expect(t.annotations.readOnlyHint).toBe(t.name.startsWith("get_"));
      expect(t.inputSchema).toMatchObject({ type: "object" });
    }
    expect(TOOLS.find((t) => t.name === "get_events")?.annotations.untrustedContentHint).toBe(true);
  });

  it("returns a structured error for unknown tools and bad input instead of throwing", () => {
    const s = store();
    expect(call(s, "nope").error.code).toBe("UNKNOWN_TOOL");
    expect(call(s, "prepare_handoff", null).error.code).toBe("UNKNOWN_ROUTE");
    expect(call(s, "execute_handoff", { handoff_id: 42 }).error.code).toBe("HANDOFF_NOT_FOUND");
  });

  it("every result is JSON serialisable and every agent call is attributed", () => {
    const s = store();
    for (const t of TOOLS) {
      const r = call(s, t.name, t.name === "prepare_handoff" ? { target: "gpt-5.6-sol", reason: "Sol is ready and not metered." } : { handoff_id: "H-229" });
      expect(() => JSON.stringify(r)).not.toThrow();
    }
    expect(s.get().agentCalls).toHaveLength(TOOLS.length);
  });
});
