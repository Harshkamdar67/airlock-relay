// Drives prepare, approve, execute, and the Resume button through WebMCP in
// headless Chrome against a running bridge. Used by scripts/resume-e2e.sh.
import puppeteer from "puppeteer-core";

const port = process.env.RELAY_PORT ?? "4792";
const route = process.env.RELAY_ROUTE ?? "sonnet";
const chrome = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const target = { sonnet: "claude-sonnet-5[1m]", opus: "claude-opus-5[1m]", sol: "gpt-5.6-sol", fable: "claude-fable-5-1[1m]" }[route] ?? route;

const b = await puppeteer.launch({ executablePath: chrome, headless: "new", args: ["--enable-features=WebMCPTesting,WebMCP"], defaultViewport: { width: 1440, height: 900 } });
const pg = await b.newPage();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (n, i = {}) => pg.evaluate(async ([n, i]) => { const mc = document.modelContext; const t = (await mc.getTools()).find((x) => x.name === n); return JSON.parse(await mc.executeTool(t, JSON.stringify(i))); }, [n, i]);
const click = (sel) => pg.evaluate((s) => { const el = document.querySelector(s); if (!el) throw new Error("missing " + s); el.click(); }, sel);

await pg.goto("http://127.0.0.1:" + port + "/", { waitUntil: "networkidle0" });
await wait(1500);
const s = await run("get_session");
console.log("session:", s.session.mode, s.session.status, s.session.active_model);
const p = await run("prepare_handoff", { target, reason: "Resume end-to-end check on a scratch session.", allow_metered: true });
console.log("prepared:", p.ok, p.handoff?.id ?? "", p.error?.code ?? "");
if (!p.ok) { await b.close(); process.exit(1); }
await click('button[data-action="approve"]');
await wait(800);
const h = await run("get_handoff");
const ex = await run("execute_handoff", { handoff_id: h.handoff.id, approval_token: h.handoff.approval_token });
console.log("executed:", ex.ok);
await wait(2500);
await click('button[data-action="resume"]');
await wait(3500);
const st = await pg.evaluate(() => { const el = document.querySelector(".resume"); return el ? el.textContent.replace(/\s+/g, " ").trim() : "no resume block"; });
console.log("resume block:", st.slice(0, 240));
await b.close();
