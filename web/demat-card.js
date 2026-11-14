// A stored Demat as display text. A quote-only value is empty, not `""`.
// Import paths read the printed value from a CAS and store a quoted string in
// some older rows, so both spellings must be read the same way.
export function dematText(value) {
  return String(value ?? "").replace(/^"+|"+$/g, "").trim();
}
