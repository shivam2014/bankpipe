// Does the Demat printed on a broker report belong to the portfolio it is being
// imported into? The two numbers come from different places (a report preamble
// and a portfolio field a person may have typed), so only the digits are
// compared; the last six are the account number, and the leading zeros vary.
//
// "unknown" is not a failure: a portfolio with no Demat yet is being linked for
// the first time, and refusing that import would block the first sync.

const digits = (value) => String(value ?? "").replace(/\D+/g, "");

export function matchDemat(reportDemat, targetNumber) {
  const report = digits(reportDemat);
  const target = digits(targetNumber);
  if (report.length < 6 || target.length < 6) return "unknown";
  return report.slice(-6) === target.slice(-6) ? "match" : "mismatch";
}
