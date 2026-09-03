// Copies the fresh dist/ build into bridge/site so `python bridge/relay.py`
// works from a clone with Python alone. With --check it fails when the
// committed copy is stale, which CI uses.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = path.join(root, "dist");
const site = path.join(root, "bridge", "site");
const check = process.argv.includes("--check");

function walk(dir, base = dir, out = {}) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else if (!entry.name.endsWith(".map")) out[path.relative(base, full).replace(/\\/g, "/")] = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
  }
  return out;
}

if (!fs.existsSync(path.join(dist, "index.html"))) {
  console.error("dist/index.html missing; run npm run build first");
  process.exit(2);
}
const fresh = walk(dist);
if (check) {
  const committed = fs.existsSync(site) ? walk(site) : {};
  const same = JSON.stringify(fresh) === JSON.stringify(committed);
  console.log(same ? "bridge/site is up to date" : "bridge/site is stale; run npm run build:bridge");
  process.exit(same ? 0 : 1);
}
fs.rmSync(site, { recursive: true, force: true });
fs.mkdirSync(site, { recursive: true });
for (const rel of Object.keys(fresh)) {
  const target = path.join(site, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(dist, rel), target);
}
console.log(`copied ${Object.keys(fresh).length} files to bridge/site`);
