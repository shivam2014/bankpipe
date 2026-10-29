import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { escapeHtml, jsArg } from "./escape.js";

test("escapes every HTML metacharacter", () => {
  assert.equal(escapeHtml(`<img src=x onerror="alert(1)">`),
    "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  assert.equal(escapeHtml("' onmouseover='x"), "&#39; onmouseover=&#39;x");
  assert.equal(escapeHtml("a & b"), "a &amp; b");
});

test("leaves normal text and numbers alone", () => {
  assert.equal(escapeHtml("Bank of Baroda · 99990092461"), "Bank of Baroda · 99990092461");
  assert.equal(escapeHtml(1234.5), "1234.5");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
});

test("an injected label cannot open an element", () => {
  const label = `<img src=x onerror="document.body.dataset.xss='1'">`;
  const rendered = `<div class="nm">${escapeHtml(label)}</div>`;
  assert.ok(!rendered.includes("<img"));
  assert.ok(rendered.includes("&lt;img"));
  assert.ok(!rendered.includes(`onerror="document`));
});

// Reverse of escapeHtml for the attribute-decoding step a browser performs
// before it compiles an inline handler.
const decodeEntities = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g,
  (_, name) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[name]);

test("jsArg produces a JS string literal that survives adversarial ids", () => {
  for (const id of [
    `x');alert(document.body.dataset.xss='1');//`,
    `a"b'c<d>e&f`,
    `line\nbreak\u2028separator`,
    "back\\slash",
  ]) {
    const arg = jsArg(id);
    // No raw metacharacter may reach the HTML parser.
    assert.ok(!/[<>'"]/.test(arg), `raw metacharacter in ${arg}`);
    // The browser decodes the attribute, then the JS parser reads it back.
    assert.equal(JSON.parse(decodeEntities(arg)), id);
  }
});

test("jsArg cannot break out of an inline onclick attribute", () => {
  const id = `x');document.body.dataset.xss='1';//`;
  const html = `<button onclick="bpAsset(${jsArg(id)})">Edit</button>`;
  assert.ok(!html.includes(`onclick="bpAsset('`));
  assert.ok(!html.includes("');"));
  assert.equal(html, `<button onclick="bpAsset(&quot;x&#39;);document.body.dataset.xss=&#39;1&#39;;//&quot;)">Edit</button>`);
});

test("jsArg leaves ordinary ids and numbers readable", () => {
  assert.equal(jsArg("savings-1"), "&quot;savings-1&quot;");
  assert.equal(jsArg(42), "&quot;42&quot;");
  assert.equal(jsArg(null), "&quot;&quot;");
});

test("index.html keeps workbook fields and record ids escaped", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  for (const sink of ["${l.sheet}", "${l.status}", "${l.asset}", "${l.detail}",
    "${l.match}", "${r.purpose}", "${r.asset}", "${r.status}"]) {
    assert.ok(!html.includes(sink), `${sink} must go through escapeHtml`);
  }
  assert.doesNotMatch(html, /onclick="[^"]*'\$\{[^}]*\.(?:id|account_id|asset_id)\}'/,
    "an id in an inline handler must use jsArg, not HTML escaping alone");
  assert.doesNotMatch(html, /<option value="\$\{[^}]*\.id\}"/,
    "an option value must go through escapeHtml");
});
