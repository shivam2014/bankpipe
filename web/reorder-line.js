const count = (n) => Number(n || 0).toLocaleString("en-IN");

const runLabel = (run) => {
  const range = `rows ${Number(run.from)}-${Number(run.to)}`;
  const convention = run.convention === "opening" ? "opening"
    : run.convention === "post" ? "post-entry"
      : run.convention === "mixed" ? "mixed" : "";
  if (run.formula) {
    if (run.mixed || run.unreadable) {
      const why = run.mixed ? "mixed" : "unreadable";
      const inferred = convention && convention !== "mixed"
        ? `, inferred ${convention}` : "";
      return `${range} formula (${why}${inferred})`;
    }
    return `${range} formula${convention ? ` (${convention})` : ""}`;
  }
  return `${range} inferred${convention ? ` (${convention})` : ""}`;
};

// The sheet line shows the first three runs and counts the rest. The receipt
// keeps every run; only the inline list is capped. Decline reasons go on their
// own line so a long sheet does not become one unreadable sentence.
export function reorderLine(r) {
  const moved = Number(r?.reorder?.moved || 0);
  const reason = String(r?.reorder?.reason || "");
  const sign = Number(r?.reorder?.signCorrected || 0);
  const runs = Array.isArray(r?.reorder?.runs) ? r.reorder.runs : [];
  const shown = runs.slice(0, 3);
  const hidden = runs.length - shown.length;
  const more = hidden
    ? `+${count(hidden)} more run${hidden === 1 ? "" : "s"}` : "";
  const showRuns = runs.length > 1 || runs.some((run) => run.formula)
    || runs.some((run) => run.convention === "opening" || run.convention === "mixed")
    || moved > 0 || sign > 0 || !!reason;
  const runsText = showRuns
    ? [...shown.map(runLabel), more].filter(Boolean).join(" · ") : "";
  const signText = sign
    ? `sign corrected on ${count(sign)} row${sign === 1 ? "" : "s"}` : "";
  const status = moved ? `reordered ${count(moved)} rows`
    : (r?.reorder?.verifiedAsPrinted ? "order verified as printed" : "");
  const state = reason ? (moved ? reason : `order unchanged: ${reason}`) : "";
  const head = [runsText, status, signText].filter(Boolean).join(" · ");
  return [head, state].filter(Boolean).join("\n");
}
