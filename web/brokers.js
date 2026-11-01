// Brokers that publish a bond portfolio you can import. DigiFInn is the first
// one; adding another is a new entry here plus its parser, not a rewrite of the
// portfolio page.
//
// Each entry describes the reports a broker publishes. `slot` must match the
// `kind` that the report parser returns, because the file picker checks the two
// agree before it accepts a file.

export const BOND_BROKERS = [
  {
    id: "digifinn",
    label: "DigiFInn",
    page: { url: "https://www.digifinn.com/profile", where: "Reports & Documents" },
    reports: [
      { slot: "portfolio", title: "Portfolio Report",
        detail: "ISIN, quantity, cost, purchase date",
        files: ["holdings-report-*.csv"] },
      { slot: "investment", title: "Investment Report",
        detail: "Issuer, coupon, maturity, yield",
        files: ["investment-report-*.csv"] },
      { slot: "payouts", title: "Cashflow Future",
        detail: "Next payout, the full month-by-month schedule, part redemptions",
        files: ["portfolio-cashflow-future*.csv"] },
    ],
  },
];

export function bondBroker(id = "digifinn") {
  return BOND_BROKERS.find((b) => b.id === id) || BOND_BROKERS[0] || null;
}
