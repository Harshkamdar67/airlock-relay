import { RelayStore } from "./runtime/state";
import { buildDemoState } from "./runtime/demo";
import type { Scenario } from "./runtime/types";
import { connectLive } from "./runtime/live";
import { registerRelayTools } from "./webmcp/register";
import { runWalkthrough } from "./webmcp/walkthrough";
import { bind, render, type UiContext } from "./ui/app";

const root = document.getElementById("app") as HTMLElement;
const store = new RelayStore(buildDemoState());

const ctx: UiContext = {
  store,
  webmcp: null,
  walkthroughRunning: false,
  onReset: () => {
    store.replace(buildDemoState(new Date(), store.get().scenario));
  },
  onScenario: (scenario: Scenario) => {
    if (store.get().mode !== "demo") return;
    store.replace(buildDemoState(new Date(), scenario));
  },
  onResume: () => {
    const state = store.get();
    const h = state.handoff;
    if (state.mode !== "live" || !h || h.status !== "executed") return;
    void postJson("/relay/api/resume", { handoff_id: h.id, nonce: resumeNonces.get(h.id) ?? "" })
      .then((body) => {
        const launched = body.launched === true;
        const command = typeof body.command === "string" ? body.command : state.bridge?.resumeCommand ?? "";
        const status = launched ? `Opened a terminal running \`${command}\`` : `Not launched: ${String(body.reason ?? (body.dry_run ? "dry run" : "unknown"))}`;
        store.setBridgeResume(command || null, status);
        store.recordBridgeResult(status, body);
      })
      .catch((error: unknown) => store.recordBridgeResult(`Bridge unreachable: ${error instanceof Error ? error.message : String(error)}`));
  },
  onWalkthrough: () => {
    if (ctx.walkthroughRunning) return;
    ctx.walkthroughRunning = true;
    render(root, ctx);
    void runWalkthrough(store).finally(() => {
      ctx.walkthroughRunning = false;
      render(root, ctx);
    });
  },
};

bind(root, ctx);
render(root, ctx);
store.subscribe(() => render(root, ctx));

// Countdowns and "resumed" liveness. In demo mode a resumed session shows a
// handful of simulated completed requests (labelled scenario) so the state
// after a handoff is visibly alive; the timer stops after a few.
let resumedTicks = 0;
setInterval(() => {
  const state = store.get();
  if (state.mode === "demo" && state.session.status === "running" && state.handoff?.status === "executed" && resumedTicks < 6) {
    resumedTicks += 1;
    store.simulateRequest();
  } else if (state.session.status !== "running") {
    resumedTicks = 0;
    store.touch();
  }
}, 5000);

// Live mode. The human's Approve click is also recorded by the local bridge,
// which hands back a one-shot nonce. An executed handoff is then sent to the
// bridge with that nonce, and the bridge refuses to run Airlock's own
// `airlock handoff set` unless the nonce matches an approval it recorded for
// the same proposal, revision, and target.
const bridgeNonces = new Map<string, string>();
const resumeNonces = new Map<string, string>();
const postedApprovals = new Set<string>();
const postedHandoffs = new Set<string>();
async function postJson(path: string, body: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return (await r.json()) as Record<string, unknown>;
}
store.subscribe((state) => {
  const h = state.handoff;
  if (state.mode !== "live" || !h) return;
  const key = `${h.id}:${h.revision}`;
  if (h.status === "approved" && !postedApprovals.has(key)) {
    postedApprovals.add(key);
    void postJson("/relay/api/approve", { handoff_id: h.id, revision: h.revision, from: h.from, target: h.target })
      .then((body) => { if (typeof body.nonce === "string") bridgeNonces.set(key, body.nonce); })
      .catch(() => undefined);
  }
  if (h.status === "executed" && !postedHandoffs.has(h.id)) {
    postedHandoffs.add(h.id);
    void postJson("/relay/api/handoff", { handoff_id: h.id, revision: h.revision, from: h.from, target: h.target, nonce: bridgeNonces.get(key) ?? "" })
      .then((body) => {
        const applied = body.applied === true;
        const command = typeof body.command === "string" ? body.command : "";
        const summary = applied ? `Bridge ran \`${command}\`` : `Bridge did not apply ${h.id}: ${String(body.reason ?? "unknown")}${command ? ` (run \`${command}\` yourself)` : ""}`;
        if (typeof body.resume_nonce === "string") resumeNonces.set(h.id, body.resume_nonce);
        if (typeof body.resume_command === "string") store.setBridgeResume(body.resume_command, null);
        store.recordBridgeResult(summary, body);
      })
      .catch((error: unknown) => store.recordBridgeResult(`Bridge unreachable: ${error instanceof Error ? error.message : String(error)}`));
  }
});

// A console handle exists only when the page is opened with ?debug=1, so a
// stray script cannot reach the store's human-only methods in normal use.
if (new URLSearchParams(location.search).get("debug") === "1") {
  (window as unknown as { airlockRelay: unknown }).airlockRelay = { store };
}

void (async () => {
  ctx.webmcp = await registerRelayTools(store);
  render(root, ctx);
  // Live mode is opt-in by the local bridge: it serves this same build and
  // answers ./relay/api/state. On GitHub Pages that request 404s and we stay in demo.
  await connectLive(store);
  render(root, ctx);
})();
