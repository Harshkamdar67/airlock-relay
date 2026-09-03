// Opens the built site in a real Chrome with WebMCP testing enabled and
// exercises the tools through document.modelContext, not through the page's
// own functions. Usage: node scripts/webmcp-smoke.mjs [url] [chromePath]

import puppeteer from "puppeteer-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const url = process.argv[2] ?? "http://127.0.0.1:4173/";
const chromePath =
  process.argv[3] ??
  process.env.CHROME_PATH ??
  ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome"].find((p) => fs.existsSync(p));
const features = process.env.WEBMCP_FEATURES ?? "WebMCPTesting,WebMCP";
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-chrome-"));

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: process.env.HEADFUL ? false : "new",
  userDataDir,
  args: [`--enable-features=${features}`, "--no-first-run", "--no-default-browser-check", "--window-size=1440,900"],
  defaultViewport: { width: 1440, height: 900 },
});
const page = await browser.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("[page error]", m.text()); });
await page.goto(url, { waitUntil: "networkidle0" });
await new Promise((r) => setTimeout(r, 800));

const probe = await page.evaluate(async () => {
  const mc = document.modelContext ?? navigator.modelContext;
  if (!mc) return { available: false, keys: Object.getOwnPropertyNames(Object.getPrototypeOf(document)).filter((k) => /model|context|tool/i.test(k)) };
  const tools = typeof mc.getTools === "function" ? await mc.getTools() : null;
  return { available: true, methods: Object.getOwnPropertyNames(Object.getPrototypeOf(mc)), tools: tools ? tools.map((t) => t.name) : null };
});
console.log("WebMCP probe:", JSON.stringify(probe));

let exit = 0;
if (probe.available && probe.tools?.length) {
  const run = async (name, input = {}) =>
    page.evaluate(
      async ([n, i]) => {
        const mc = document.modelContext ?? navigator.modelContext;
        const tool = (await mc.getTools()).find((t) => t.name === n);
        if (!tool) throw new Error(`tool ${n} not registered`);
        const raw = await mc.executeTool(tool, JSON.stringify(i));
        let value = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (value && Array.isArray(value.content)) value = JSON.parse(value.content.map((c) => c.text ?? "").join(""));
        return value;
      },
      [name, input],
    );
  const session = await run("get_session");
  console.log("get_session:", session.ok, session.session?.status, session.session?.active_model);
  const routes = await run("get_routes");
  console.log("get_routes:", routes.routes?.length, "routes");
  const refusedMetered = await run("prepare_handoff", { target: "claude-fable-5-1[1m]", reason: "Stay on Claude for continuity." });
  console.log("prepare_handoff metered:", refusedMetered.ok ? "UNEXPECTED OK" : refusedMetered.error.code);
  const prepared = await run("prepare_handoff", { target: "gpt-5.6-sol", reason: "Sol is ready, frontier tier, and not metered." });
  console.log("prepare_handoff sol:", prepared.ok, prepared.handoff?.id);
  const early = await run("execute_handoff", { handoff_id: prepared.handoff.id });
  console.log("execute before approval:", early.ok ? "UNEXPECTED OK" : early.error.code);
  // Human acts in the page.
  await page.select('select[data-action="target"]', "claude-fable-5-1[1m]");
  await page.click('button[data-action="approve"]');
  const handoff = await run("get_handoff");
  console.log("get_handoff after human edit+approve:", handoff.handoff?.status, "rev", handoff.handoff?.revision, "target", handoff.handoff?.target, "changes", handoff.human_changes_since_created);
  const executed = await run("execute_handoff", { handoff_id: prepared.handoff.id, approval_token: handoff.handoff.approval_token });
  console.log("execute_handoff:", executed.ok, executed.result?.active);
  const after = await run("get_session");
  console.log("session after:", after.session?.status, after.session?.active_model);
  const replay = await run("get_replay");
  console.log("replay actors:", [...new Set(replay.replay.map((e) => e.actor))].join(","));
  const ok = session.ok && !refusedMetered.ok && prepared.ok && !early.ok && executed.ok && after.session.status === "running" && after.session.active_model === "claude-fable-5-1[1m]";
  console.log(ok ? "SMOKE OK" : "SMOKE FAILED");
  exit = ok ? 0 : 1;
  await page.screenshot({ path: "docs/screenshot-after-handoff.png" });
} else {
  console.log("Tools not visible through WebMCP. Try WEBMCP_FEATURES=<name> or enable chrome://flags/#enable-webmcp-testing.");
  exit = 2;
}
await browser.close();
fs.rmSync(userDataDir, { recursive: true, force: true });
process.exit(exit);
