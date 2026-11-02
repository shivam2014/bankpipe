import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { parseDate } from "./parse.js";
import { parseTransactions } from "./workbook.js";

const require = createRequire(import.meta.url);
const XLSX = require("./vendor/xlsx.full.min.js");

test("a date-formatted serial reaches parseDate as a date string", () => {
  const ws = XLSX.utils.aoa_to_sheet([
    ["Date", "Description", "Amount"],
    [40366, "ONLINE CARD", -240063],
  ]);
  ws.A2.z = "m/d/yy";
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Txns");
  const bytes = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  const read = XLSX.read(bytes, { type: "array", cellDates: false });
  const matrix = XLSX.utils.sheet_to_json(read.Sheets.Txns, {
    header: 1, raw: false, defval: "",
  });
  const arrives = matrix[1][0];
  console.log(`date cell arrives as: ${JSON.stringify(arrives)} (${typeof arrives})`);
  console.log(`parseDate returns: ${parseDate(arrives)}`);
  assert.equal(typeof arrives, "string");
  assert.equal(parseDate(arrives), "2010-07-07");
  const parsed = parseTransactions(matrix, {
    header_row: 1,
    columns: [
      { col: "A", kind: "date", role: "value" },
      { col: "B", kind: "free_text", role: "label" },
      { col: "C", kind: "amount", role: "value" },
    ],
  });
  assert.equal(parsed.rows[0].date, "2010-07-07");
  assert.deepEqual(parsed.noDateRows, []);
});
