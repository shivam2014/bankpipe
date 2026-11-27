#!/usr/bin/env node
// Rebuild the Motilal Portfolio Holding Summary fixture from its printed
// geometry. The span table in motilal-fixture-spans.json holds the page, x, y,
// font size and text of every item the redacted export printed. This script
// draws those items on blank pages with a standard font, so the committed PDF
// shares the export's column geometry and none of its bytes, fonts or objects.
//
//   node scripts/motilal-fixture.mjs
//
// Writes web/fixtures/motilal/motilal-portfolio-holding-summary-synthetic.pdf.
// Synthetic data only. The span table is the generator's input.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PAGE_WIDTH = 842;
const PAGE_HEIGHT = 595;

const SPANS = new URL("./motilal-fixture-spans.json", import.meta.url);
const FIXTURE = new URL(
  "../web/fixtures/motilal/motilal-portfolio-holding-summary-synthetic.pdf",
  import.meta.url);

// WinAnsi keeps the standard Helvetica font, so no source font is embedded.
// The export prints one bullet and no other character outside Latin-1.
const WINANSI = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84],
  [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88],
  [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c],
  [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93],
  [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
  [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);

function winAnsi(value) {
  let out = "";
  for (const char of String(value)) {
    const code = char.codePointAt(0);
    if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) out += char;
    else if (WINANSI.has(code)) out += String.fromCharCode(WINANSI.get(code));
    else out += "?";
  }
  return out;
}

const escape = (value) => value.replace(/[\\()]/g, (char) => `\\${char}`);

function pageContent(items) {
  const lines = ["0 g"];
  for (const [index, [x, y, size, text]] of items.entries()) {
    // The export sets headings at 10.85pt and up; the rest is body text.
    const bold = size >= 10.85;
    const alias = index % 2 === 0 ? "" : "b";
    lines.push("BT");
    lines.push(`/${bold ? "T2" : "T1"}${alias} ${size} Tf`);
    lines.push(`1 0 0 1 ${x} ${y} Tm`);
    lines.push(`(${escape(winAnsi(text))}) Tj`);
    lines.push("ET");
  }
  return Buffer.from(lines.join("\n"), "latin1");
}

// Uncompressed content keeps the bytes identical across runs and Node
// versions, so the test can assert the committed fixture is this output.
export function buildPdf(geometry) {
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };

  const catalog = add("<< /Type /Catalog /Pages 2 0 R >>");
  const pages = add("");
  const regular = add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const bold = add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  // Two resource names per face. pdf.js joins neighbouring items only while the
  // font name is unchanged, so alternating the alias keeps one item per span.
  const regularAlt = add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const boldAlt = add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");

  const pageIds = [];
  for (const page of geometry) {
    const content = pageContent(page.items);
    const contentId = add({ stream: content });
    pageIds.push(add(`<< /Type /Page /Parent 2 0 R `
      + `/MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] `
      + `/Resources << /Font << /T1 ${regular} 0 R /T2 ${bold} 0 R `
      + `/T1b ${regularAlt} 0 R /T2b ${boldAlt} 0 R >> >> `
      + `/Contents ${contentId} 0 R >>`));
  }
  objects[pages - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] `
    + `/Count ${pageIds.length} >>`;

  const chunks = [];
  let offset = 0;
  const push = (buffer) => { chunks.push(buffer); offset += buffer.length; };
  push(Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1"));
  const offsets = [0];
  for (const [index, body] of objects.entries()) {
    offsets.push(offset);
    push(Buffer.from(`${index + 1} 0 obj\n`, "latin1"));
    if (body && body.stream) {
      push(Buffer.from(`<< /Length ${body.stream.length} >>\nstream\n`, "latin1"));
      push(body.stream);
      push(Buffer.from("\nendstream\n", "latin1"));
    } else {
      push(Buffer.from(body, "latin1"));
      push(Buffer.from("\n", "latin1"));
    }
    push(Buffer.from("endobj\n", "latin1"));
  }
  const xref = offset;
  const lines = ["xref", `0 ${objects.length + 1}`, `${"0".repeat(10)} 65535 f `];
  for (let id = 1; id <= objects.length; id += 1) {
    lines.push(`${String(offsets[id]).padStart(10, "0")} 00000 n `);
  }
  push(Buffer.from(lines.join("\n") + "\n", "latin1"));
  push(Buffer.from(`trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\n`
    + `startxref\n${xref}\n%%EOF\n`, "latin1"));
  return Buffer.concat(chunks);
}

export function generate() {
  return buildPdf(JSON.parse(readFileSync(SPANS, "utf8")));
}

const invoked = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invoked) {
  const geometry = JSON.parse(readFileSync(SPANS, "utf8"));
  const pdf = buildPdf(geometry);
  const [file] = process.argv.slice(2);
  const target = file ? resolve(file) : fileURLToPath(FIXTURE);
  writeFileSync(target, pdf);
  console.log(`${target}: ${pdf.length} bytes, ${geometry.length} pages`);
}
