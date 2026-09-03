// Copies the fresh dist/ build into bridge/site so `python bridge/relay.py`
// works from a clone with Python alone. With --check it fails when the
// committed copy is stale, which CI uses. Line endings are normalised to LF
// so Windows and Linux builds compare equal.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = path.join(root, "dist");
const site = path.join(root, "bridge", "site");
const check = process.argv.includes("--check");

function normalize(buffer) {
  return Buffer.from(buffer.toString("utf8").split("\r\n").join("\n"), "utf8");
}

function walk(dir, base = dir, out = {}) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else if (!entry.name.endsWith(".map")) {
      const rel = path.relative(base, full).split(path.sep).join("/");
      out[rel] = crypto.createHash("sha256").update(normalize(fs.readFileSync(full))).digest("hex");
    }
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
  const freshKeys = Object.keys(fresh).sort();
  const committedKeys = Object.keys(committed).sort();
  const same = JSON.stringify(freshKeys) === JSON.stringify(committedKeys) && freshKeys.every((k) => fresh[k] === committed[k]);
  console.log(same ? "bridge/site is up to date" : "bridge/site is stale; run npm run build:bridge");
  process.exit(same ? 0 : 1);
}
fs.rmSync(site, { recursive: true, force: true });
fs.mkdirSync(site, { recursive: true });
for (const rel of Object.keys(fresh)) {
  const target = path.join(site, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, normalize(fs.readFileSync(path.join(dist, rel))));
}
console.log(`copied ${Object.keys(fresh).length} files to bridge/site`);
