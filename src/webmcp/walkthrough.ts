// A scripted stand-in for a browser agent. It calls the same tool entry
// point WebMCP does, so the page behaves identically; it exists for judges
// whose browser has no WebMCP and for the fallback in the demo video.

import type { RelayStore } from "../runtime/state";
import { invokeTool } from "./tools";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runWalkthrough(store: RelayStore, pace = 900): Promise<void> {
  const call = (name: string, input: unknown = {}) => invokeTool(store, name, input) as any;
  await sleep(pace / 2);
  const session = call("get_session");
  await sleep(pace);
  call("get_events", { limit: 12 });
  await sleep(pace);
  const routes = call("get_routes");
  await sleep(pace);
  const ready = (routes.routes as Array<{ id: string; metered: boolean; tier: string; status: string; is_active: boolean; fits_session_context: boolean }>).filter((r) => r.status === "ready" && !r.is_active && r.fits_session_context);
  const pick = ready.find((r) => !r.metered && r.tier === "frontier") ?? ready.find((r) => !r.metered) ?? ready[0];
  if (!pick || session.session.status !== "blocked") return;
  const prepared = call("prepare_handoff", {
    target: pick.id,
    reason: `${pick.id} is ready, ${pick.tier} tier, fits the session's context, and does not spend metered usage. Checkpoint, worktree, and task are preserved.`,
  });
  if (!prepared.ok) return;
  const id = prepared.handoff.id as string;
  await sleep(pace);
  // The agent tries early and is refused: approval is the human's move.
  call("execute_handoff", { handoff_id: id });
  // Poll until the human approves, rejects, or the proposal is replaced.
  for (let i = 0; i < 600; i += 1) {
    await sleep(1000);
    const h = store.get().handoff;
    if (!h || h.id !== id) return;
    if (h.status === "rejected" || h.status === "superseded" || h.status === "executed") return;
    if (h.status === "approved") break;
    if (i % 8 === 7) call("get_handoff", { handoff_id: id });
  }
  const latest = call("get_handoff", { handoff_id: id });
  if (!latest.ok || latest.handoff.status !== "approved") return;
  await sleep(pace);
  call("execute_handoff", { handoff_id: id, approval_token: latest.handoff.approval_token });
  await sleep(pace / 2);
  call("get_session");
  await sleep(pace / 2);
  call("get_replay");
}
