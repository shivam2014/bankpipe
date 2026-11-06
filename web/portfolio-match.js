// Does the Demat printed on a broker report belong to the portfolio it is being
// imported into? The two numbers come from different places (a report preamble
// and a portfolio field a person may have typed), so both are read as BO IDs and
// compared whole.
//
// It used to compare the last six digits, which cannot separate two accounts
// that share a tail: IN30302873183122 and IN30302811183122 are different clients
// of one DP and both end 183122. Six digits are not an identity.
//
// "unknown" is not a failure. A client code, a truncated number or an empty
// field cannot confirm or deny a demat, and refusing that import would block the
// first sync. A spreadsheet that dropped a character gives 15 digits, and
// guessing the missing one is worse than asking.

import { boId } from "./bo-id.js";

export function matchDemat(reportDemat, targetNumber) {
  const report = boId(reportDemat);
  const target = boId(targetNumber);
  if (report.kind !== "bo" || target.kind !== "bo") return "unknown";
  return report.boId === target.boId ? "match" : "mismatch";
}
