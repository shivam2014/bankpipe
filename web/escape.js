// The one HTML text/attribute escaper. `'` is included so a future
// single-quoted attribute cannot break out either.
const MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => MAP[char]);
}

// A JavaScript string literal that is safe inside an HTML attribute.
// JSON.stringify quotes and escapes the value for the JS parser; escapeHtml
// then protects the attribute, because the browser decodes entities before
// the handler runs. HTML-escaping alone is not enough: an id like
// `x');alert(1)//` survives &quot; decoding as a live JS string break.
// The U+2028/U+2029 replacements keep the literal valid on older parsers.
export function jsArg(value) {
  const literal = JSON.stringify(String(value ?? ""))
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return escapeHtml(literal);
}
