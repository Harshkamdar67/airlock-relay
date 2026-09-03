// Records the demo video. Drives the page through Chrome's real WebMCP
// document.modelContext.executeTool, shows a synthetic cursor for the human
// actions, and overlays a scripted agent transcript that is labelled as such.
// Usage: node scripts/record-demo.mjs [demoUrl] [liveUrl]

import puppeteer from "puppeteer-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const demoUrl = process.argv[2] ?? "http://127.0.0.1:4173/";
const liveUrl = process.argv[3] ?? "http://127.0.0.1:4783/";
const chromePath = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ffmpeg = process.env.FFMPEG_PATH ?? (spawnSync("bash", ["-lc", "command -v ffmpeg"], { encoding: "utf8" }).stdout || "ffmpeg").trim();
const videoDir = path.resolve("video");
const timeline = JSON.parse(fs.readFileSync(path.join(videoDir, "timeline.json"), "utf8"));
const starts = [];
let acc = 0.6; // lead-in before narration starts
for (const seg of timeline) { starts.push(acc); acc += seg.seconds; }
const total = acc + 1.5;
const at = (key, frac = 0) => { const i = timeline.findIndex((s) => s.key === key); return starts[i] + timeline[i].seconds * frac; };

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-rec-"));
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: "new",
  userDataDir,
  args: ["--enable-features=WebMCPTesting,WebMCP", "--no-first-run", "--window-size=1440,900", "--hide-scrollbars", "--force-device-scale-factor=1"],
  defaultViewport: { width: 1440, height: 900 },
});
const page = await browser.newPage();
await page.goto(demoUrl, { waitUntil: "networkidle0" });
await page.waitForFunction(() => document.querySelector(".pill.ok") !== null, { timeout: 10000 });

const OVERLAY_CSS = `
#rc-cursor { position: fixed; z-index: 99999; width: 22px; height: 22px; pointer-events: none; transform: translate(-3px,-2px); transition: left .55s cubic-bezier(.2,.8,.2,1), top .55s cubic-bezier(.2,.8,.2,1); left: 720px; top: 460px; filter: drop-shadow(0 2px 4px rgba(0,0,0,.6)); }
#rc-cursor.click { animation: rc-click .35s ease; }
@keyframes rc-click { 0% { transform: translate(-3px,-2px) scale(1);} 40% { transform: translate(-3px,-2px) scale(.8);} 100% { transform: translate(-3px,-2px) scale(1);} }
#rc-agent { position: fixed; right: 20px; bottom: 20px; width: 400px; max-height: 46vh; z-index: 99990; background: #0d141dee; border: 1px solid #2a3749; border-radius: 12px; box-shadow: 0 14px 40px rgba(0,0,0,.55); font: 13px/1.45 Inter, system-ui, sans-serif; color: #e6edf5; display: flex; flex-direction: column; overflow: hidden; opacity: 0; transform: translateY(12px); transition: opacity .4s, transform .4s; }
#rc-agent.show { opacity: 1; transform: none; }
#rc-agent header { padding: 9px 12px; border-bottom: 1px solid #1f2a3a; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #8b9bb0; display: flex; gap: 8px; align-items: center; }
#rc-agent header i { width: 8px; height: 8px; border-radius: 50%; background: #6fb3ff; display: inline-block; }
#rc-agent header small { margin-left: auto; text-transform: none; letter-spacing: 0; color: #5f6f85; font-size: 10.5px; }
#rc-agent .msgs { padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; overflow: auto; }
#rc-agent .m { padding: 8px 11px; border-radius: 10px; max-width: 92%; white-space: pre-wrap; }
#rc-agent .m.user { align-self: flex-end; background: #1d2a3d; }
#rc-agent .m.agent { align-self: flex-start; background: #12202a; border: 1px solid #1f3a33; }
#rc-agent .m.agent b { color: #58d3a7; }
#rc-agent .m.tool { align-self: flex-start; font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; color: #8b9bb0; padding: 2px 6px; }
#rc-ring { position: fixed; z-index: 99980; border: 2px solid #58d3a7; border-radius: 999px; pointer-events: none; opacity: 0; transition: all .4s; box-shadow: 0 0 0 6px rgba(88,211,167,.18); }
#rc-ring.show { opacity: 1; }
#rc-end { position: fixed; inset: 0; z-index: 99995; background: #0b1017; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; opacity: 0; transition: opacity .6s; font-family: Inter, system-ui, sans-serif; }
#rc-end.show { opacity: 1; }
#rc-end h1 { margin: 0; font-size: 40px; letter-spacing: .14em; color: #e6edf5; display: flex; align-items: center; gap: 16px; }
#rc-end h1 i { width: 22px; height: 22px; border-radius: 50%; background: #58d3a7; box-shadow: 0 0 0 8px rgba(88,211,167,.15); }
#rc-end p { margin: 0; color: #8b9bb0; font-size: 18px; }
#rc-end code { color: #58d3a7; font-size: 20px; }
`;

async function installOverlay() {
  await page.evaluate((css) => {
    if (document.getElementById("rc-style")) return;
    const style = document.createElement("style"); style.id = "rc-style"; style.textContent = css; document.head.appendChild(style);
    const cursor = document.createElement("div"); cursor.id = "rc-cursor";
    cursor.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 2l16 9.5-7.2 1.6 4.2 7.4-2.9 1.6-4.2-7.4L4 19z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg>`;
    document.body.appendChild(cursor);
    const ring = document.createElement("div"); ring.id = "rc-ring"; document.body.appendChild(ring);
    const agent = document.createElement("div"); agent.id = "rc-agent";
    agent.innerHTML = `<header><i></i>Browser agent<small>scripted for this recording · tool calls are real WebMCP calls</small></header><div class="msgs"></div>`;
    document.body.appendChild(agent);
  }, OVERLAY_CSS);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const waitUntil = async (seconds) => { const ms = t0 + seconds * 1000 - Date.now(); if (ms > 0) await sleep(ms); };

async function moveCursor(selector) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel); if (!el) return;
    const r = el.getBoundingClientRect();
    const c = document.getElementById("rc-cursor");
    c.style.left = `${r.left + r.width / 2}px`; c.style.top = `${r.top + r.height / 2}px`;
  }, selector);
  await sleep(650);
}
async function clickWithCursor(selector) {
  await moveCursor(selector);
  await page.evaluate(() => { const c = document.getElementById("rc-cursor"); c.classList.remove("click"); void c.offsetWidth; c.classList.add("click"); });
  await page.click(selector);
}
async function ring(selector, pad = 8) {
  await page.evaluate(([sel, p]) => {
    const el = sel ? document.querySelector(sel) : null; const ring = document.getElementById("rc-ring");
    if (!el) { ring.classList.remove("show"); return; }
    const r = el.getBoundingClientRect();
    ring.style.left = `${r.left - p}px`; ring.style.top = `${r.top - p}px`; ring.style.width = `${r.width + 2 * p}px`; ring.style.height = `${r.height + 2 * p}px`; ring.classList.add("show");
  }, [selector, pad]);
}
async function say(role, text, typeMs = 0) {
  await page.evaluate(async ([role, text, typeMs]) => {
    const panel = document.getElementById("rc-agent"); panel.classList.add("show");
    const msgs = panel.querySelector(".msgs");
    const m = document.createElement("div"); m.className = `m ${role}`; msgs.appendChild(m);
    if (role === "agent") { m.innerHTML = `<b>Agent</b> · ${text}`; }
    else if (typeMs > 0) { for (let i = 1; i <= text.length; i += 1) { m.textContent = text.slice(0, i); await new Promise((r) => setTimeout(r, typeMs)); } }
    else m.textContent = text;
    msgs.scrollTop = msgs.scrollHeight;
  }, [role, text, typeMs]);
}
async function tool(name, input = {}) {
  await say("tool", `→ ${name}(${JSON.stringify(input)})`);
  const result = await page.evaluate(async ([n, i]) => {
    const mc = document.modelContext;
    const t = (await mc.getTools()).find((x) => x.name === n);
    const raw = await mc.executeTool(t, JSON.stringify(i));
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  }, [name, input]);
  return result;
}

const recorder = await page.screencast({ path: path.join(videoDir, "demo.webm"), ffmpegPath: ffmpeg });
await installOverlay();

// intro: blocked session
await waitUntil(at("intro", 0.15));
await ring(".status.blocked", 6);
await moveCursor(".status.blocked");
await waitUntil(at("intro", 0.6));
await ring(".routes li.cooldown", 4);
await moveCursor(".routes li.cooldown");

// tools: WebMCP pill
await waitUntil(at("tools", 0.05));
await ring(".pill.ok", 6);
await moveCursor(".pill.ok");
await waitUntil(at("tools", 0.6));
await ring(null);

// prompt: agent panel + typing
await waitUntil(at("prompt", 0));
const PROMPT = "My Airlock coding session looks blocked. Inspect what happened, then get it running again on a route that is ready and does not spend metered usage. Do not change the active model until I approve the handoff in this page.";
await say("user", PROMPT, 14);
await waitUntil(at("prompt", 0.62));
await tool("get_session");
await waitUntil(at("prompt", 0.8));
await tool("get_events", { limit: 12 });

// propose
await waitUntil(at("propose", 0.05));
await tool("get_routes");
await waitUntil(at("propose", 0.3));
const prepared = await tool("prepare_handoff", { target: "gpt-5.6-sol", reason: "Anthropic plan is rate limited (chain exhausted). GPT-5.6 Sol is ready, frontier tier, and not metered. Checkpoint cp_184, worktree, and task are preserved." });
await ring(".handoff .fromto", 6);
await waitUntil(at("propose", 0.55));
await say("agent", "Opus 5 hit a 429 and the Anthropic plan pool went on cooldown, so every Claude route except metered Fable is unavailable for ~14 min. I proposed <b>H-229</b>: Opus → GPT-5.6 Sol (ready, frontier, not metered). Nothing is switched yet; it needs your approval in the page.");

// refuse
await waitUntil(at("refuse", 0.05));
await tool("execute_handoff", { handoff_id: prepared.handoff.id });
await ring("#activity-log li:last-child", 4);
await waitUntil(at("refuse", 0.45));
await say("agent", "Execution was refused: <b>APPROVAL_REQUIRED</b>. I'll wait for you to approve.");

// edit + approve
await waitUntil(at("edit", 0.02));
await ring(null);
await moveCursor('select[data-action="target"]');
await waitUntil(at("edit", 0.22));
await page.select('select[data-action="target"]', "claude-fable-5-1[1m]");
await page.evaluate(() => { const c = document.getElementById("rc-cursor"); c.classList.remove("click"); void c.offsetWidth; c.classList.add("click"); });
await waitUntil(at("edit", 0.5));
await clickWithCursor('button[data-action="approve"]');
await ring(".changes", 6);
await waitUntil(at("edit", 0.85));
await ring(null);

// execute
await waitUntil(at("execute", 0.02));
await say("user", "continue");
await waitUntil(at("execute", 0.2));
const h = await tool("get_handoff");
await waitUntil(at("execute", 0.45));
await tool("execute_handoff", { handoff_id: h.handoff.id, approval_token: h.handoff.approval_token });
await ring(".status.running", 6);
await moveCursor(".status.running");
await waitUntil(at("execute", 0.7));
await say("agent", "You changed the target to Claude Fable 5.1 (metered) and approved revision 2, so I executed with that token. The session is <b>running</b> on Fable from checkpoint cp_184.");

// replay
await waitUntil(at("replay", 0.02));
await ring(null);
await page.evaluate(() => { document.getElementById("rc-agent").classList.remove("show"); });
await tool("get_replay");
await page.evaluate(() => document.querySelector(".replay")?.scrollIntoView({ behavior: "smooth", block: "center" }));
await sleep(700);
await ring(".replay", 6);
await moveCursor(".replay li:last-child");

// live
await waitUntil(at("live", 0));
await page.evaluate(() => document.getElementById("rc-agent")?.remove());
let liveOk = false;
try {
  await page.goto(liveUrl, { waitUntil: "networkidle0", timeout: 8000 });
  await page.waitForFunction(() => document.querySelector(".pill.live") !== null, { timeout: 5000 });
  liveOk = true;
} catch { /* fall back to staying on demo */ }
await installOverlay();
if (liveOk) { await ring(".pill.live", 6); await moveCursor(".pill.live"); }
await waitUntil(at("live", 0.75));
await ring(null);

// outro: end card
await waitUntil(at("outro", 0.15));
await page.evaluate(() => {
  const end = document.createElement("div"); end.id = "rc-end";
  end.innerHTML = `<h1><i></i>AIRLOCK RELAY</h1><p>A WebMCP control room for humans and agents supervising coding sessions together</p><code>harshkamdar67.github.io/airlock-relay</code><p>github.com/Harshkamdar67/airlock-relay</p>`;
  document.body.appendChild(end); requestAnimationFrame(() => end.classList.add("show"));
});
await waitUntil(total);
await recorder.stop();
await browser.close();
fs.rmSync(userDataDir, { recursive: true, force: true });
console.log("recorded", path.join(videoDir, "demo.webm"), "live mode shown:", liveOk, "planned", total.toFixed(1), "s");
