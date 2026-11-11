// Brokers that publish a bond portfolio you can import. DigiFInn is the first
// one; adding another is a new entry here plus its parser, not a rewrite of the
// portfolio page.
//
// Each entry describes the reports a broker publishes. `slot` must match the
// `kind` that the report parser returns, because the file picker checks the two
// agree before it accepts a file. `optional` reports add detail when present but
// never block a save.

import { parseReportFile } from "./digifinn-reports.js";

export const BOND_BROKERS = [
  {
    id: "digifinn",
    label: "DigiFInn",
    logo: "broker-logos/digifinn.webp",
    parser: "digifinn",
    page: { url: "https://www.digifinn.com/profile", where: "Reports & Documents" },
    reports: [
      { slot: "portfolio", title: "Portfolio Report",
        detail: "cost and purchase date",
        files: ["holdings-report-YYYY-MM-DD.csv"],
        example: "holdings-report-2026-10-26.csv" },
      { slot: "payouts", title: "Payouts report", optional: true,
        detail: "payment frequency and next interest",
        files: ["upcoming-payouts.csv"] },
    ],
  },
];

// A broker's files are read by that broker's parser. The map keeps the parser
// choice next to the registry entry instead of spreading `if (broker === ...)`
// through the import card.
const PARSERS = { digifinn: parseReportFile };

export function bondBroker(id = "digifinn") {
  return BOND_BROKERS.find((b) => b.id === id) || BOND_BROKERS[0] || null;
}

export function brokerLogo(id = "digifinn") {
  return bondBroker(id)?.logo || "";
}

// Which report slots this app can actually apply. The registry may list more
// (an investment report, say) for the page to show; only these are wired.
export const IMPORT_SLOTS = ["portfolio", "payouts", "cashflow"];

export function brokerReport(id, slot) {
  return (bondBroker(id)?.reports || []).find((r) => r.slot === slot) || null;
}

export function parseBrokerReport(brokerId, text, fileName = "") {
  // Strict lookup: an unknown id must fail closed rather than read the file as
  // the first broker's format.
  const broker = BOND_BROKERS.find((b) => b.id === brokerId);
  const parse = broker && PARSERS[broker.parser];
  return parse ? parse(text, fileName) : { kind: "unknown", fileName };
}

// Equity statements carry the purchase date and invested amount the CAS never
// prints. These brokers are registered now so the holding card can send a person
// to the import; each file format is wired when its report is known.
export const EQUITY_BROKERS = [
  { id: "motilal", label: "Motilal Oswal",
    page: { url: "https://www.motilaloswal.com/", where: "Reports" } },
  { id: "zerodha", label: "Zerodha",
    page: { url: "https://console.zerodha.com/", where: "Reports" } },
];

export function equityBroker(id) {
  return EQUITY_BROKERS.find((b) => b.id === id) || null;
}
