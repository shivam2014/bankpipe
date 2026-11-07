// Which importer should read a file the person just chose. The extension alone
// cannot tell a bank CSV from a broker CSV, so the name is a hint and the answer
// is only ever a default: the dropdown sits right there to correct it.
//
// Pure: the caller passes a file name, it returns one of the three kinds.

export const IMPORT_KINDS = ["bank", "cas", "broker"];

export const IMPORT_KIND_LABEL = {
  bank: "Bank statement",
  cas: "Demat CAS statement",
  broker: "Broker holdings",
};

/** @param {string} name @returns {"bank"|"cas"|"broker"} */
export function guessKind(name) {
  const text = String(name || "").toLowerCase();
  if (/consolidated|\bcas\b|e-?cas/.test(text)) return "cas";
  if (/holding|portfolio|tradebook|contract/.test(text)) return "broker";
  if (/statement|stmt|account/.test(text)) return "bank";
  if (/\.pdf$/.test(text)) return "bank";
  return "broker";
}
