// Refreshes the documentation screenshots and the link-preview image.
// Expects `npx vite preview --port 4173 --host 127.0.0.1` for the demo, and
// optionally live bridges on 4783 (Airlock) and 4784 (Claude Code).
import puppeteer from "puppeteer-core";

const chrome = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const demo = process.argv[2] ?? "http://127.0.0.1:4173/app/";
const b = await puppeteer.launch({ executablePath: chrome, headless: "new", args: ["--enable-features=WebMCPTesting,WebMCP"] });
const pg = await b.newPage();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (n, i = {}) => pg.evaluate(async ([n, i]) => { const mc = document.modelContext; const t = (await mc.getTools()).find((x) => x.name === n); return JSON.parse(await mc.executeTool(t, JSON.stringify(i))); }, [n, i]);
const click = (sel) => pg.evaluate((s) => { const el = document.querySelector(s); if (!el) throw new Error("missing " + s); el.click(); }, sel);
const reachable = async (url) => { try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; } };

await pg.setViewport({ width: 1440, height: 900 });
await pg.goto(demo, { waitUntil: "networkidle0" }); await wait(1500);
await pg.screenshot({ path: "docs/screenshot-blocked.png" });
await pg.select('select[data-action="scenario"]', "context_overflow"); await wait(600);
await pg.screenshot({ path: "docs/screenshot-overflow.png" });
await pg.select('select[data-action="scenario"]', "rate_limit"); await wait(300);
await pg.setViewport({ width: 800, height: 900 }); await wait(400);
await pg.screenshot({ path: "docs/screenshot-narrow.png" });
await pg.setViewport({ width: 1200, height: 630 }); await wait(300);
await pg.screenshot({ path: "public/og.png" });
await pg.setViewport({ width: 1440, height: 900 });
await pg.goto(demo.replace(/app\/?$/, ""), { waitUntil: "networkidle0" }); await wait(1200);
await pg.screenshot({ path: "docs/screenshot-landing.png" });
await pg.goto(demo.replace(/app\/?$/, "connect/"), { waitUntil: "networkidle0" }); await wait(800);
await pg.screenshot({ path: "docs/screenshot-connect.png" });
await pg.setViewport({ width: 1440, height: 900 });

if (await reachable("http://127.0.0.1:4783/relay/api/state")) {
  await pg.goto("http://127.0.0.1:4783/app/", { waitUntil: "networkidle0" }); await wait(1500);
  await run("get_session");
  const routes = await run("get_routes");
  const pick = routes.routes.find((r) => r.status === "ready" && !r.is_active && r.fits_session_context && !r.metered) ?? routes.routes.find((r) => r.status === "ready" && !r.is_active && r.fits_session_context);
  if (pick) {
    await run("prepare_handoff", { target: pick.id, reason: `${pick.label} is ready, fits the conversation, and does not spend metered usage.`, allow_metered: pick.metered });
    await click('button[data-action="approve"]'); await wait(700);
    const h = await run("get_handoff"); await run("execute_handoff", { handoff_id: h.handoff.id, approval_token: h.handoff.approval_token }); await wait(1500);
  }
  await pg.evaluate(() => window.scrollTo(0, 0)); await wait(300);
  await pg.screenshot({ path: "docs/screenshot-live-mode.png" });
  console.log("live airlock shot ok");
}
if (await reachable("http://127.0.0.1:4784/relay/api/state")) {
  await pg.goto("http://127.0.0.1:4784/app/", { waitUntil: "networkidle0" }); await wait(1500);
  await run("get_session"); await run("get_routes"); await wait(400);
  await pg.screenshot({ path: "docs/screenshot-claude-code.png" });
  console.log("live claude-code shot ok");
}
await b.close();
console.log("shots ok");
