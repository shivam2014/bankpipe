// A demat account is spelled three different ways in the wild: the BO ID a
// depository prints, the same number with stray spaces or dashes from a report,
// and a broker's own client code. Only the first two identify an account. A
// client code is a label, never a key: 8504986299 is a Motilal client code and
// 6638002 a UCID, and neither can be compared with a BO ID.
//
// The old matcher compared the last six digits, which cannot tell two accounts
// apart when they share a tail. This reads the whole number instead. Pure: no
// storage, no network.

const clean = (value) =>
  String(value ?? "").replace(/[^0-9a-zA-Z]/g, "").toUpperCase();

// CDSL prints 16 characters: "IN" plus an 8-character DP ID and an 8-digit
// client ID. NSDL prints 16 digits: an 8-digit DP ID and an 8-digit client ID.
const CDSL = /^IN\d{14}$/;
const NSDL = /^\d{16}$/;

/**
 * Read an account number into its parts. Never guesses: anything that is not a
 * BO ID comes back with an empty `boId` and a `kind` saying what it was.
 * @param {string} raw
 * @returns {{boId: string, depository: string, dpId: string, clientId: string,
 *   kind: "bo"|"client-code"|"unknown"|"empty", code: string}}
 */
export function boId(raw) {
  const text = clean(raw);
  const none = { boId: "", depository: "", dpId: "", clientId: "", code: text };
  if (!text) return { ...none, kind: "empty" };
  if (CDSL.test(text)) {
    return { boId: text, depository: "CDSL", dpId: text.slice(0, 8),
      clientId: text.slice(8), code: text, kind: "bo" };
  }
  if (NSDL.test(text)) {
    return { boId: text, depository: "NSDL", dpId: text.slice(0, 8),
      clientId: text.slice(8), code: text, kind: "bo" };
  }
  if (/^\d{6,15}$/.test(text)) return { ...none, kind: "client-code" };
  return { ...none, kind: "unknown" };
}

/**
 * Do two spellings name the same account? "unknown" when either side is not a
 * BO ID: a client code cannot confirm or deny a demat, and refusing that link
 * would block the first sync.
 * @param {string} a
 * @param {string} b
 * @returns {"match"|"mismatch"|"unknown"}
 */
export function sameAccount(a, b) {
  const one = boId(a);
  const two = boId(b);
  if (one.kind !== "bo" || two.kind !== "bo") return "unknown";
  return one.boId === two.boId ? "match" : "mismatch";
}

/**
 * The short form for a row label: depository plus the last four digits, so a
 * person can tell two accounts apart without a 16-character number on screen.
 * @param {string} raw
 * @returns {string} e.g. "CDSL …3122", or "" when there is no BO ID
 */
export function boIdShort(raw) {
  const id = boId(raw);
  if (id.kind !== "bo") return "";
  return `${id.depository} …${id.boId.slice(-4)}`;
}
