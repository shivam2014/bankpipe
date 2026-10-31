// Renders every Mermaid source in docs/diagrams to SVG with the same renderer
// the atlas uses, so a syntax error fails locally before CI sees it.
//
//   node scripts/docs/render.mjs           write the SVGs
//   node scripts/docs/render.mjs --check   fail when an SVG is stale or orphaned
import {
  existsSync, readFileSync, readdirSync, writeFileSync,
} from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "pele";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DIR = join(ROOT, "docs/diagrams");
const CHECK = process.argv.includes("--check");

const THEME = [
  "<style>",
  ".pele{",
  "--pele-bg:#fffcf0;",
  "--pele-fg:#100f0f;",
  "--pele-muted:#6f6e69;",
  "--pele-line:#100f0f;",
  "--pele-surface:#f2f0e5;",
  "--pele-surface-alt:#e6e4d9;",
  "--pele-border:#cecdc3;",
  "--pele-accent:#205ea6;",
  "--pele-radius:6px;",
  "--pele-font:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Inter,sans-serif;",
  "}",
  "</style>",
].join("");

const sources = readdirSync(DIR).filter((file) => file.endsWith(".mmd")).sort();
if (!sources.length) {
  console.error("docs: no Mermaid sources in docs/diagrams");
  process.exit(1);
}

const rendered = new Map();
for (const file of sources) {
  let result;
  try {
    result = render(readFileSync(join(DIR, file), "utf8"), {
      limit: 1_000_000,
      outputLimit: 8_000_000,
      maxEdges: 10_000,
    });
  } catch (error) {
    console.error(`docs: ${file}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  const svg = result.svg.replace(/^(<svg[^>]*>)/, `$1${THEME}`);
  rendered.set(
    basename(file, ".mmd") + ".svg",
    `<?xml version="1.0" encoding="UTF-8"?>\n${svg}\n`,
  );
}

const orphans = readdirSync(DIR)
  .filter((file) => file.endsWith(".svg"))
  .filter((file) => !sources.includes(basename(file, ".svg") + ".mmd"));

if (CHECK) {
  const stale = [...rendered].filter(([file, body]) => {
    const path = join(DIR, file);
    return !existsSync(path) || readFileSync(path, "utf8") !== body;
  }).map(([file]) => file);
  const problems = [...stale, ...orphans.map((file) => `${file} (no .mmd source)`)];
  if (problems.length) {
    console.error(`docs: stale or orphaned diagrams:\n  ${problems.join("\n  ")}`);
    console.error("Run node scripts/docs/render.mjs and commit the result.");
    process.exit(1);
  }
  console.log(`docs: ${rendered.size} SVGs current`);
} else {
  for (const [file, body] of rendered) writeFileSync(join(DIR, file), body);
  if (orphans.length) {
    console.error(`docs: ignoring orphaned SVGs (no .mmd source): ${orphans.join(", ")}`);
  }
  console.log(`docs: wrote ${rendered.size} SVGs`);
}
