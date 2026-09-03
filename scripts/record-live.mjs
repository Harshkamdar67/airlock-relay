// Records a real, unscripted-looking session end to end on this machine:
//   1. a Git Bash terminal starts `airlock hybrid grok` in a demo project and
//      sends a task; Grok answers 402 and Airlock detours the request
//   2. the bridge is started from inside the session with `!`
//   3. a Chrome window opens the live console; tools are called through
//      WebMCP; a handoff to Opus is proposed, approved, executed
//   4. the blocked session is exited, Resume opens a terminal that continues
//      the same conversation on Opus, and one more message is sent
// The desktop region 0,0 1440x900 is captured with ffmpeg gdigrab.
// Usage: FFMPEG_PATH=... node scripts/record-live.mjs

import puppeteer from "puppeteer-core";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
const chromePath = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const mintty = "C:/Program Files/Git/usr/bin/mintty.exe";
const project = process.env.DEMO_PROJECT ?? path.join(process.env.USERPROFILE ?? "", "work", "ledger-api");
const projectBash = project.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`);
const relayPy = path.join(here, "bridge", "relay.py").replace(/\\/g, "/");
const bridgePort = 4790;
const out = path.join(here, "video", "live.mp4");
const TERM_TITLE = "Airlock demo";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const runStart = Date.now();

function ps(script) {
  return spawnSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" });
}
function sendKeysEscape(text) {
  return text.replace(/[+^%~(){}\[\]]/g, (c) => `{${c}}`);
}
// A target is a window title prefix (string) or { proc: "mintty", nth: 0 }
// meaning the newest window of that process; its live title is looked up so
// programs that rewrite the title (Bash, Claude Code) still get found.
function targetExpr(target) {
  if (typeof target === "object") {
    return `((Get-Process ${target.proc} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ne '' } | Sort-Object StartTime -Descending | Select-Object -Index ${target.nth ?? 0}).MainWindowTitle)`;
  }
  return `'${String(target).replace(/'/g, "''")}'`;
}
async function typeInto(target, text, perChar = 45) {
  // Types character by character through WScript.Shell so it looks human.
  const chunks = [];
  for (const ch of text) chunks.push(sendKeysEscape(ch));
  const script = `$w = New-Object -ComObject WScript.Shell; if (-not $w.AppActivate(${targetExpr(target)})) { throw 'no window ${target}' }; Start-Sleep -Milliseconds 200; ` +
    chunks.map((c) => `$w.SendKeys('${c.replace(/'/g, "''")}'); Start-Sleep -Milliseconds ${perChar + Math.floor(Math.random() * 40)};`).join(" ");
  const r = ps(script);
  if (r.status !== 0) log("sendkeys error", r.stderr.trim().slice(0, 200));
}
async function pressEnter(target) {
  ps(`$w = New-Object -ComObject WScript.Shell; $w.AppActivate(${targetExpr(target)}) | Out-Null; Start-Sleep -Milliseconds 150; $w.SendKeys('{ENTER}')`);
}
function activate(target) {
  const r = ps(`$w = New-Object -ComObject WScript.Shell; if (-not $w.AppActivate(${targetExpr(target)})) { Write-Output 'MISS' }`);
  if (r.stdout.includes("MISS")) log("activate missed", target);
}

// ---- scene 1: terminal, real Airlock session on Grok ---------------------------------
// The terminal gets a clean environment so the new Airlock session does not
// inherit this process's session variables.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AIRLOCK|ANTHROPIC|CLAUDE|OPENAI|CODEX|GROK|OPENROUTER)/i.test(k)));
const term = spawn(mintty, ["-p", "0,0", "-s", "158,44", "-t", TERM_TITLE, "-o", "FontHeight=12", "-o", "Font=Cascadia Mono", "-o", "Transparency=off", "--", "/usr/bin/bash", "-l", "-c", `cd '${projectBash}' && exec bash -l`], { detached: true, stdio: "ignore", env: cleanEnv });
term.unref();
const TERM = { proc: "mintty", nth: 0 };
log("terminal pid", term.pid);
await sleep(2500);
activate(TERM);
await sleep(600);

// ---- capture --------------------------------------------------------------------
fs.mkdirSync(path.dirname(out), { recursive: true });
const rec = spawn(ffmpeg, ["-y", "-f", "gdigrab", "-framerate", "30", "-offset_x", "0", "-offset_y", "0", "-video_size", "1440x900", "-i", "desktop", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", out], { stdio: ["pipe", "ignore", "ignore"] });
log("recording to", out);
await sleep(1500);
await typeInto(TERM, "clear && ls src && git log --oneline | head -3");
await pressEnter(TERM);
await sleep(2200);
await typeInto(TERM, "airlock hybrid grok");
await pressEnter(TERM);
log("waiting for the session to start");
await sleep(9000);
// First run in this folder: Claude Code asks whether to trust it. The cursor
// starts on "No, exit"; Down then Enter selects "Yes, I trust this folder".
ps(`$w = New-Object -ComObject WScript.Shell; $w.AppActivate(${targetExpr(TERM)}) | Out-Null; Start-Sleep -Milliseconds 200; $w.SendKeys('{DOWN}'); Start-Sleep -Milliseconds 400; $w.SendKeys('{ENTER}')`);
await sleep(10000);
await typeInto(TERM, "Read src/auth.js and propose how to move session tokens from bearer headers to signed httpOnly cookies. Keep it to a short plan.");
await pressEnter(TERM);
log("waiting for Grok to fail, the router to detour, and the answer to finish");
// The session is idle once its transcript stops growing.
const projectSlug = project.replace(/[^A-Za-z0-9]/g, "-");
const transcriptDir = path.join(process.env.USERPROFILE ?? "", ".claude", "projects", projectSlug);
const newestTranscript = () => {
  if (!fs.existsSync(transcriptDir)) return null;
  const files = fs.readdirSync(transcriptDir).filter((f) => /^[0-9a-f-]{36}\.jsonl$/.test(f)).map((f) => path.join(transcriptDir, f));
  if (!files.length) return null;
  return files.map((f) => ({ f, m: fs.statSync(f).mtimeMs })).sort((a, b) => b.m - a.m)[0];
};
{
  const started = Date.now();
  let lastM = 0;
  let changes = 0;
  let stableSince = Date.now();
  while (Date.now() - started < 300000) {
    await sleep(3000);
    const t = newestTranscript();
    const m = t && t.m > runStart ? t.m : 0;
    if (m !== lastM) { lastM = m; stableSince = Date.now(); changes += 1; }
    if (Date.now() - started > 40000 && changes >= 2 && Date.now() - stableSince > 25000 && m > 0) break;
  }
  log("session idle after", Math.round((Date.now() - started) / 1000), "s; transcript", path.basename(newestTranscript()?.f ?? "none"));
}
await sleep(3000);

// ---- scene 2: start the bridge from inside the session --------------------------------
await typeInto(TERM, `! (nohup python "${relayPy}" --port ${bridgePort} --task "Move session tokens to signed cookies" --workdir "$(pwd)" --no-desktop-notify > /tmp/relay-live.log 2>&1 &) && sleep 2 && tail -2 /tmp/relay-live.log`);
await pressEnter(TERM);
for (let i = 0; i < 20; i += 1) {
  await sleep(1500);
  try {
    const r = await fetch(`http://127.0.0.1:${bridgePort}/relay/api/state`);
    if (r.ok) { const j = await r.json(); log("bridge up:", j.bridge.source, j.diagnostics.root_model, "cooldowns", JSON.stringify(j.diagnostics.rate_limit_cooldowns)); break; }
  } catch {}
}
await sleep(3000);

// ---- scene 3: Chrome on the live console -------------------------------------------
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  defaultViewport: null,
  args: ["--enable-features=WebMCPTesting,WebMCP", "--window-position=0,0", "--window-size=1440,900", "--no-first-run", "--no-default-browser-check", "--disable-infobars", `--user-data-dir=${path.join(here, "video", "chrome-profile")}`],
});
const page = (await browser.pages())[0] ?? (await browser.newPage());
await page.goto(`http://127.0.0.1:${bridgePort}/app/`, { waitUntil: "networkidle0" });
await page.bringToFront();
await sleep(800);
const CHROME = { proc: "chrome", nth: 0 };
for (let i = 0; i < 5; i += 1) {
  const r = ps(`$w = New-Object -ComObject WScript.Shell; $t = (Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like 'Airlock Relay*' } | Select-Object -First 1).MainWindowTitle; if ($t -and $w.AppActivate($t)) { Write-Output 'OK' } else { Write-Output 'MISS' }`);
  if (r.stdout.includes("OK")) break;
  await sleep(800);
}
void CHROME;
await page.evaluate(() => {
  const style = document.createElement("style");
  style.textContent = `#rc-cursor{position:fixed;z-index:99999;width:22px;height:22px;pointer-events:none;transition:left .5s cubic-bezier(.2,.8,.2,1),top .5s cubic-bezier(.2,.8,.2,1);left:900px;top:600px;filter:drop-shadow(0 2px 4px rgba(0,0,0,.6))}`;
  document.head.appendChild(style);
  const c = document.createElement("div"); c.id = "rc-cursor";
  c.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 2l16 9.5-7.2 1.6 4.2 7.4-2.9 1.6-4.2-7.4L4 19z" fill="#fff" stroke="#000" stroke-width="1.3" stroke-linejoin="round"/></svg>`;
  document.body.appendChild(c);
});
const moveTo = async (sel) => { await page.evaluate((s) => { const el = document.querySelector(s); if (!el) return; const r = el.getBoundingClientRect(); const c = document.getElementById("rc-cursor"); c.style.left = `${r.left + r.width / 2}px`; c.style.top = `${r.top + r.height / 2}px`; }, sel); await sleep(700); };
const clickSel = async (sel) => { await moveTo(sel); await page.evaluate((s) => document.querySelector(s)?.click(), sel); await sleep(500); };
const run = (n, i = {}) => page.evaluate(async ([n, i]) => { const mc = document.modelContext; const t = (await mc.getTools()).find((x) => x.name === n); return JSON.parse(await mc.executeTool(t, JSON.stringify(i))); }, [n, i]);
await sleep(4000);
await moveTo(".status");
await sleep(2500);
await moveTo(".routes li.cooldown");
await sleep(2500);
log("agent reads");
const s = await run("get_session"); log("session", s.session?.status, s.session?.active_model);
await sleep(1800);
await run("get_events", { limit: 12 });
await sleep(1800);
const routes = await run("get_routes");
await sleep(2000);
const opus = routes.routes.find((r) => r.id === "claude-opus-5[1m]");
const target = opus && opus.status === "ready" && opus.fits_session_context ? opus : routes.routes.find((r) => r.status === "ready" && !r.is_active && r.fits_session_context && !r.metered);
log("proposing", target?.id);
const prepared = await run("prepare_handoff", { target: target.id, reason: `${target.label} is ready, fits the conversation, and does not spend metered usage. Grok is on cooldown after the provider refused with 402. Checkpoint, worktree, and task are preserved.` });
await sleep(2500);
await run("execute_handoff", { handoff_id: prepared.handoff.id });
await sleep(3000);
await moveTo(".handoff .fromto .box.to");
await sleep(1500);
await clickSel('button[data-action="approve"]');
await sleep(2500);
const h = await run("get_handoff");
await sleep(1500);
await run("execute_handoff", { handoff_id: h.handoff.id, approval_token: h.handoff.approval_token });
await sleep(3500);
await moveTo(".status");
await sleep(2500);
await run("get_replay");
await sleep(2500);

// ---- scene 4: exit the blocked session, resume on Opus -----------------------------------
activate(TERM);
await sleep(1500);
await typeInto(TERM, "/exit");
await pressEnter(TERM);
await sleep(5000);
ps(`$w = New-Object -ComObject WScript.Shell; $t = (Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like 'Airlock Relay*' } | Select-Object -First 1).MainWindowTitle; if ($t) { $w.AppActivate($t) | Out-Null }`);
await page.bringToFront();
await sleep(1200);
await clickSel('button[data-action="resume"]');
log("resume clicked");
for (let i = 0; i < 20; i += 1) {
  await sleep(1000);
  const r = ps(`(Get-Process mintty -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ne '' } | Measure-Object).Count`);
  if (Number(r.stdout.trim()) >= 2) break;
}
activate({ proc: "mintty", nth: 0 });
await sleep(18000);
await typeInto({ proc: "mintty", nth: 0 }, "Continue with step 1 of the plan and show the diff for src/auth.js.");
await pressEnter({ proc: "mintty", nth: 0 });
await sleep(50000);

// ---- end ------------------------------------------------------------------------
rec.stdin.write("q");
await sleep(2500);
await browser.close().catch(() => {});
log("done");
