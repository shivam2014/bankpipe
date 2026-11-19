// Stamp every relative module import in the deployed bundle with the build
// commit. Browsers keep an ES module by URL, and a page reload can still reuse a
// module already in memory from the previous deployment; a changed URL is the
// only reliable way to make a corrected parser load on the next visit.
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2];
const version = String(process.argv[3] || "").trim();
if (!root || !version) {
  console.error("usage: version-assets.mjs <public-root> <version>");
  process.exit(2);
}

const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "vendor" || entry.name === "node_modules") continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(?:js|mjs|html)$/.test(entry.name)) files.push(file);
  }
}
walk(root);

const fromRe = /(from\s*["'])(\.{1,2}\/[^"']+?\.m?js)(["'])/g;
const dynamicRe = /(import\s*\(\s*["'])(\.{1,2}\/[^"']+?\.m?js)(["']\s*\))/g;
let touched = 0;
for (const file of files) {
  const before = fs.readFileSync(file, "utf8");
  const after = before
    .replace(fromRe, (match, open, spec, close) =>
      spec.includes("?") ? match : `${open}${spec}?v=${version}${close}`)
    .replace(dynamicRe, (match, open, spec, close) =>
      spec.includes("?") ? match : `${open}${spec}?v=${version}${close}`);
  if (after !== before) {
    fs.writeFileSync(file, after);
    touched += 1;
  }
}
console.log(`versioned ${touched} file(s) at ?v=${version}`);

// A service worker is byte-compared, not fetched by URL: the browser only
// installs a new one when the script's bytes change. Stamping the cache name is
// what makes a deploy open a new cache and delete the old one on the next visit.
const serviceWorker = path.join(root, "sw.js");
if (fs.existsSync(serviceWorker)) {
  const source = fs.readFileSync(serviceWorker, "utf8");
  const stamped = source.replaceAll("__BP_BUILD__", version);
  if (stamped !== source) fs.writeFileSync(serviceWorker, stamped);
  console.log(`service worker cache: ${version}`);
}
