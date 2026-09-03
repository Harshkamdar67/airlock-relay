import { RelayStore } from "./runtime/state";
import { buildDemoState } from "./runtime/demo";
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
    store.replace(buildDemoState());
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

// In live mode, an executed handoff is also handed to the local bridge, which
// runs Airlock's own `airlock handoff set` so the approved order persists.
const postedHandoffs = new Set<string>();
store.subscribe((state) => {
  const h = state.handoff;
  if (state.mode !== "live" || !h || h.status !== "executed" || postedHandoffs.has(h.id)) return;
  postedHandoffs.add(h.id);
  void fetch("./relay/api/handoff", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: h.from, target: h.target }) })
    .then(async (r) => {
      const body = (await r.json()) as { applied?: boolean; command?: string; reason?: string; output?: string[] };
      const summary = body.applied ? `Bridge ran \`${body.command}\`` : `Bridge could not apply ${h.id}: ${body.reason ?? "unknown"}${body.command ? ` (run \`${body.command}\` yourself)` : ""}`;
      store.recordBridgeResult(summary, body as Record<string, unknown>);
    })
    .catch((error: unknown) => store.recordBridgeResult(`Bridge unreachable: ${error instanceof Error ? error.message : String(error)}`));
});

// Expose a small debug handle for testing from the console and for the
// Chrome WebMCP inspector's imitation mode.
(window as unknown as { airlockRelay: unknown }).airlockRelay = { store };

void (async () => {
  ctx.webmcp = await registerRelayTools(store);
  render(root, ctx);
  // Live mode is opt-in by the local bridge: it serves this same build and
  // answers ./relay/api/state. On GitHub Pages that request 404s and we stay in demo.
  await connectLive(store);
  render(root, ctx);
})();
