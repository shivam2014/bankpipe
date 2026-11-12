// Brokers that publish a holding report you can import. DigiFInn and Motilal
// Oswal are the first two; adding another is a new entry here plus its parser,
// not a rewrite of the portfolio page.
//
// Each entry describes the reports a broker publishes. `slot` must match the
// `kind` that the report parser returns, because the file picker checks the two
// agree before it accepts a file. `optional` reports add detail when present but
// never block a save. A report can be a PDF (`format: "pdf"`) instead of a CSV.

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
        detail: "frequency, next interest and part redemptions; estimated without it",
        files: ["upcoming-payouts.csv"] },
    ],
  },
  {
    id: "motilal",
    label: "Motilal Oswal",
    parser: "motilal",
    format: "pdf",
    page: { url: "https://www.motilaloswal.com/", where: "Reports" },
    reports: [
      { slot: "portfolio", title: "Portfolio Holding Summary",
        detail: "invested, purchase date, coupon, frequency and face",
        files: ["Portfolio_Holding_Summary.pdf"], accept: ".pdf", format: "pdf" },
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
// prints. Zerodha's holdings XLSX and Motilal's Portfolio Holding Summary are
// wired; another broker is a guide here plus a parser, not a new page.
export const EQUITY_BROKERS = [
  { id: "motilal", label: "Motilal Oswal",
    page: { url: "https://www.motilaloswal.com/", where: "Reports" } },
  { id: "zerodha", label: "Zerodha",
    page: { url: "https://console.zerodha.com/portfolio/holdings",
      where: "Portfolio → Holdings" } },
];

export function equityBroker(id) {
  return EQUITY_BROKERS.find((b) => b.id === id) || null;
}
