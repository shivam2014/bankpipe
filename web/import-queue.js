// The Import queue, as copy rather than markup. One file is one row: what it
// is, where it goes, what it brings, and what it still needs. Nothing here
// reads a file or writes the ledger; the page already owns those paths.

export const TYPE_LABEL = {
  cas: "NSDL/CDSL (CAS)",
  motilal: "Motilal holdings",
  "zerodha-holdings": "Zerodha holdings",
  "zerodha-tradebook": "Zerodha tradebook",
  "icici-holdings": "ICICI Direct holdings",
  "digifinn-portfolio": "DigiFinn holdings",
  "digifinn-investment": "DigiFinn investment report",
  "digifinn-transactions": "DigiFinn transactions",
  "digifinn-payouts": "DigiFinn payouts",
  "digifinn-cashflow": "DigiFinn cashflow",
  bank: "Bank statement",
  unknown: "File",
};

const BROKER = {
  zerodha: "Zerodha",
  motilal: "Motilal Oswal",
  icici: "ICICI Direct",
  digifinn: "DigiFinn",
};

const KNOWN_SOURCE = [
  ["ICICI", "ICICI Direct"],
  ["ZERODHA", "Zerodha"],
  ["MOTILAL", "Motilal Oswal"],
  ["DIGIFINN", "DigiFinn"],
  ["HDFC", "HDFC"],
  ["ICICI BANK", "ICICI Bank"],
  ["STATE BANK", "SBI"],
  ["SBI", "SBI"],
  ["AXIS", "Axis"],
  ["KOTAK", "Kotak"],
  ["PUNJAB NATIONAL", "PNB"],
  ["PNB", "PNB"],
  ["BANK OF BARODA", "Bank of Baroda"],
  ["IDFC", "IDFC First"],
  ["YES BANK", "Yes Bank"],
  ["INDUSIND", "IndusInd"],
];

export function typeLabel(kind, fallback = "File") {
  return TYPE_LABEL[String(kind || "")] || String(fallback || TYPE_LABEL.unknown);
}

export function digitsOf(value) {
  return String(value ?? "").replace(/\D/g, "");
}

// The last four characters are all a person reads back from a long number:
// "…3122" for an account, "…8054" for a BO ID. A short alphanumeric id is
// printed whole, because four characters cut the part that tells it apart:
// "SYN500", never "…N500".
export function tail(value, size = 4) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const digits = digitsOf(text);
  if (digits.length >= size) return `…${digits.slice(-size)}`;
  if (text.length <= size) return `…${text}`;
  if (text.length <= size + 4) return text;
  return `…${text.slice(-size)}`;
}

export function sourceName(value, family = "") {
  if (BROKER[family]) return BROKER[family];
  const text = String(value || "").trim();
  if (!text) return "";
  const upper = text.toUpperCase();
  const known = KNOWN_SOURCE.find(([token]) => upper.includes(token));
  if (known) return known[1];
  const words = text.split(/\s+/)
    .filter((word) => !/^(limited|ltd|financial|services|broking|securities|private|pvt)$/i
      .test(word));
  return words.slice(0, 2).join(" ") || text;
}

// What the chosen account will actually receive. A file pointed at an account
// that already holds most of it says so, instead of repeating the file's own
// row count.
export function netConsequence(summary = {}) {
  const count = (value) => Number(value).toLocaleString("en-IN");
  const added = Number(summary.added || 0);
  const updated = Number(summary.updated || 0);
  const history = Number(summary.history || 0);
  if (!added && !updated && !history) return "Nothing new";
  if (added && !updated && !history) {
    return `${count(added)} holding${added === 1 ? "" : "s"}`;
  }
  if (!added && !updated && history) return `${count(history)} to history`;
  const parts = [];
  if (added) parts.push(`${count(added)} new`);
  if (updated) parts.push(`${count(updated)} updated`);
  if (history) parts.push(`${count(history)} to history`);
  return parts.join(" · ");
}

export function consequence({ kind = "", rows = [], parsed = null,
  accountCount = 1 } = {}) {
  const count = Number(rows?.length || 0);
  if (kind === "bank") {
    const transactions = Number(parsed?.rows?.length || rows?.length || 0);
    return `${transactions.toLocaleString("en-IN")} transaction${
      transactions === 1 ? "" : "s"}`;
  }
  if (kind === "zerodha-tradebook") {
    const trades = Number(parsed?.rows?.length || 0);
    return `${trades.toLocaleString("en-IN")} trade${trades === 1 ? "" : "s"}`;
  }
  if (accountCount > 1) {
    return `${accountCount} accounts · ${count.toLocaleString("en-IN")} holding${
      count === 1 ? "" : "s"}`;
  }
  return `${count.toLocaleString("en-IN")} holding${count === 1 ? "" : "s"}`;
}

// How the account was found. Only a real match gets this line; a target the
// person chose or the account page supplied says "Goes to".
export function matchLine(match, identityKind = "") {
  if (!match) return "";
  const kind = String(match.identityKind || identityKind || "");
  if (kind) return `${kind} match`;
  const hits = Number(match.hits || 0);
  const of = Number(match.of || 0);
  if (hits && of) return `${hits} of ${of} ISIN${of === 1 ? "" : "s"} match`;
  return "";
}

// The row's proposal when nothing on file is a match. The name is the broker or
// source, the number is the one the file prints. A folio is never called a
// demat.
export function createProposal({ family = "", source = "", key = "",
  folio = false, amc = "", dpName = "" } = {}) {
  const name = sourceName(source || dpName || key, family) || "broker";
  const suffix = tail(key || (folio ? amc : ""));
  if (folio) return `Create ${amc || name} folio${suffix ? ` ${suffix}` : ""}`;
  return `Create ${name} demat${suffix ? ` ${suffix}` : ""}`;
}

// One bar, one sentence: how many files can run now. A waiting file never
// changes the number the button acts on.
export function importButtonLabel(ready) {
  const n = Number(ready || 0);
  return `Import ${n} ready file${n === 1 ? "" : "s"}`;
}

export function waitingText({ password = 0, account = 0, unread = 0,
  review = 0 } = {}) {
  const parts = [];
  if (password) parts.push(`${password} need${password === 1 ? "s" : ""} a password`);
  if (account) parts.push(`${account} need${account === 1 ? "s" : ""} an account`);
  if (review) parts.push(`${review} need${review === 1 ? "s" : ""} a review`);
  if (unread) parts.push(`${unread} couldn't be read`);
  if (!parts.length) return "";
  if (parts.length === 1) return `${parts[0]}.`;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}.`;
}

// A locked PDF has no account yet: the statement's own content is what names
// it. Say that instead of guessing from the file name.
export function lockedAccountLine() {
  return "Account shown after it opens.";
}

export function passwordHint({ kind = "", name = "", source = "" } = {}) {
  const hay = `${kind} ${name} ${source}`.toLowerCase();
  if (/motilal|portfolio.?holding.?summary/.test(hay)) return "The password Motilal sent";
  if (/cas|cdsl|nsdl|depositor/.test(hay)) return "Usually your PAN in capitals";
  if (/bank|statement/.test(hay)) return "Usually your PAN, date of birth or customer ID";
  return "The password the sender used";
}
