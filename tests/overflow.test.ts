import { describe, expect, it } from "vitest";
import { RelayStore } from "../src/runtime/state";
import { buildDemoState } from "../src/runtime/demo";
import { invokeTool } from "../src/webmcp/tools";

function store() {
  let t = new Date("2026-09-03T07:00:00Z").getTime();
  return new RelayStore(buildDemoState(new Date("2026-09-03T07:00:00Z"), "context_overflow"), { now: () => new Date((t += 1000)) });
}
const call = (s: RelayStore, name: string, input: unknown = {}) => invokeTool(s, name, input) as any;

describe("context overflow scenario", () => {
  it("starts blocked on Sol for context overflow with every route ready", () => {
    const s = store();
    const session = call(s, "get_session").session;
    expect(session.status).toBe("blocked");
    expect(session.blocked_reason).toBe("context_overflow");
    expect(session.active_model).toBe("gpt-5.6-sol");
    expect(session.context_tokens).toBe(412_300);
    expect(session.context_window).toBe(400_000);
    expect(session.scenario).toBe("context_overflow");
    const routes = call(s, "get_routes").routes as Array<{ id: string; status: string; fits_session_context: boolean; provider_headroom: { used_percent: number } | null }>;
    expect(routes.every((r) => r.status === "ready")).toBe(true);
    expect(routes.find((r) => r.id === "gpt-5.6-terra")?.fits_session_context).toBe(false);
    expect(routes.find((r) => r.id === "grok-4.6")?.fits_session_context).toBe(true);
    expect(routes.find((r) => r.id === "claude-opus-5[1m]")?.provider_headroom?.used_percent).toBe(62);
  });

  it("refuses a route whose window is too small and lists routes with room", () => {
    const s = store();
    const r = call(s, "prepare_handoff", { target: "gpt-5.6-terra", reason: "Terra is ready and not metered." });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("CONTEXT_EXCEEDS_ROUTE_WINDOW");
    const ids = r.error.routes_with_room.map((x: any) => x.id);
    expect(ids).toContain("grok-4.6");
    expect(ids).toContain("claude-opus-5[1m]");
    expect(ids).not.toContain("gpt-5.6-luna");
    expect(s.get().handoff).toBeNull();
  });

  it("accepts a roomy route and resumes there after approval", () => {
    const s = store();
    const r = call(s, "prepare_handoff", { target: "grok-4.6", reason: "Grok 4.6 has a 2M window and is not metered." });
    expect(r.ok).toBe(true);
    expect(r.handoff.id).toBe("H-412");
    s.humanApprove();
    const token = call(s, "get_handoff").handoff.approval_token;
    const ex = call(s, "execute_handoff", { handoff_id: "H-412", approval_token: token });
    expect(ex.ok).toBe(true);
    expect(call(s, "get_session").session.active_model).toBe("grok-4.6");
  });

  it("human cannot switch the target to a route without room either", () => {
    const s = store();
    call(s, "prepare_handoff", { target: "grok-4.6", reason: "Grok 4.6 has a 2M window and is not metered." });
    expect(s.humanSetTarget("gpt-5.6-luna")).toBe(false);
    expect(s.get().handoff?.revision).toBe(1);
    expect(s.humanSetTarget("claude-opus-5[1m]")).toBe(true);
    expect(s.get().handoff?.revision).toBe(2);
  });
});

describe("simulated activity after resume", () => {
  it("adds scenario-labelled requests only while running", () => {
    const s = store();
    const initial = s.get().events.length;
    s.simulateRequest();
    expect(s.get().events).toHaveLength(initial);
    call(s, "prepare_handoff", { target: "grok-4.6", reason: "Grok 4.6 has a 2M window and is not metered." });
    s.humanApprove();
    const token = call(s, "get_handoff").handoff.approval_token;
    call(s, "execute_handoff", { handoff_id: "H-412", approval_token: token });
    const before = s.get().session.contextTokens;
    s.simulateRequest();
    const added = s.get().events.at(-1)!;
    expect(added.source).toBe("scenario");
    expect(added.kind).toBe("request_completed");
    expect(s.get().session.contextTokens).toBeGreaterThan(before);
  });
});
