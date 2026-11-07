// Which importer should read a file the person just chose. The name is a hint;
// the content is the evidence. A CDSL export called "SEP2026_AA06635090_TXN"
// looks like nothing in particular until its first page says "Consolidated
// Account Statement", and a bank statement that mentions NSDL is still a bank
// statement.
//
// Pure: the caller passes a name and whatever text it managed to read.

export const IMPORT_KINDS = ["bank", "cas", "broker"];

export const IMPORT_KIND_LABEL = {
  bank: "Bank statement",
  cas: "Demat CAS statement",
  broker: "Broker holdings",
};

const CAS_WORDS = [
  /consolidated\s+account\s+statement/i,
  /e-?cas\b/i,
  /demat\s+account\s+(no|number)/i,
  /holdings?\s+statement.*depositor/i,
  /national\s+securities\s+depository/i,
  /central\s+depository\s+services/i,
];

const BROKER_HEADER = (text) => /(^|\n)[^\n]*\bisin\b[^\n]*\b(quantity|qty|units)\b/i.test(text)
  && /(buy\s*value|current\s*value|average\s*cost|investment\s*value|market\s*value)/i.test(text);

const BANK_HEADER = (text) => /(withdrawal|deposit|debit|credit)/i.test(text)
  && /(balance|closing\s*balance)/i.test(text)
  && /(narration|description|particulars|remarks)/i.test(text);

/**
 * Decide what a file is from its content.
 * @param {{name?: string, text?: string}} input
 * @returns {"bank"|"cas"|"broker"|""} empty when the content says nothing useful
 */
export function sniffKind({ name = "", text = "" } = {}) {
  const body = String(text || "");
  if (body.trim()) {
    if (CAS_WORDS.some((re) => re.test(body))) return "cas";
    if (BROKER_HEADER(body)) return "broker";
    if (BANK_HEADER(body)) return "bank";
  }
  // Nothing in the content decided it. Saying so lets the caller report an
  // honest "guessed from the name" instead of claiming it read the file.
  return "";
}

/** @param {string} name @returns {"bank"|"cas"|"broker"} */
export function guessKind(name) {
  const text = String(name || "").toLowerCase();
  // Depository names, the CDSL "…_TXN" export and its AA-numbered filename all
  // mean the same thing even when the word CAS never appears in the name.
  if (/consolidated|\bcas\b|e-?cas|nsdl|cdsl|_txn\b|aa\d{8}/.test(text)) return "cas";
  if (/holding|portfolio|tradebook|contract/.test(text)) return "broker";
  if (/statement|stmt|account/.test(text)) return "bank";
  if (/\.pdf$/.test(text)) return "bank";
  return "broker";
}
