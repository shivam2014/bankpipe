import test from "node:test";
import assert from "node:assert/strict";
import { parseHoldingsMatrix, parseNumber, parseMoney, parseDate, diffHoldings }
  from "./holding-import.js";

test("finds a holdings header below a title row", () => {
  const matrix = [
    ["BondsIndia holdings as on 25 Oct 2026"],
    [],
    ["ISIN", "Security Name", "Quantity", "Buy Value", "Current Value", "Purchase Date"],
    ["INE123A07012", "Muthoot Finance NCD 2029", 10, "1,00,000", "1,08,500", "12/03/2024"],
    ["INE456B07019", "Tata Capital NCD", 25, "2,50,000", "2,61,000", "01 Apr 2023"],
    ["Total", "", "", "3,50,000", "3,69,500", ""],
    ["INE999C07010", "Sold bond", 0, "10,000", "0", ""],
  ];
  const out = parseHoldingsMatrix(matrix);
  assert.equal(out.headerRow, 2);
  assert.equal(out.rows.length, 2);
  assert.equal(out.rows[0].security_id, "INE123A07012");
  assert.equal(out.rows[0].cost_paise, 10000000);
  assert.equal(out.rows[0].value_paise, 10850000);
  assert.equal(out.rows[0].purchase_date, "2024-03-12");
  assert.equal(out.rows[1].purchase_date, "2023-04-01");
  assert.equal(out.skipped, 2);
});

test("reads a demat export with symbol and quantity", () => {
  const out = parseHoldingsMatrix([
    ["Symbol", "Company", "Qty", "Invested", "Market Value"],
    ["INFY", "Infosys", "40", "60,000", "71,200"],
    ["HDFCBANK", "HDFC Bank", "25", "38,000", "41,000"],
  ]);
  assert.equal(out.rows.length, 2);
  assert.equal(out.rows[0].security_id, "INFY");
  assert.equal(out.rows[0].quantity, 40);
  assert.equal(out.rows[1].value_paise, 4100000);
});

test("parses Indian numbers and dates", () => {
  assert.equal(parseNumber("1,23,456.78"), 123456.78);
  assert.equal(parseMoney("₹ 1,23,456.78"), 12345678);
  assert.equal(parseDate("31/03/2025"), "2025-03-31");
  assert.equal(parseDate("2025-03-31"), "2025-03-31");
  assert.equal(parseDate("7 Sep 2022"), "2022-09-07");
});

test("diffs added, removed and changed holdings", () => {
  const before = [
    { security_id: "A", label: "A", quantity: 10, cost_paise: 100, value_paise: 120 },
    { security_id: "B", label: "B", quantity: 5, cost_paise: 50, value_paise: 60 },
    { security_id: "C", label: "C", quantity: 1, cost_paise: 10, value_paise: 10 },
  ];
  const after = [
    { security_id: "A", label: "A", quantity: 12, cost_paise: 120, value_paise: 130 },
    { security_id: "B", label: "B", quantity: 5, cost_paise: 50, value_paise: 60 },
    { security_id: "D", label: "D", quantity: 2, cost_paise: 20, value_paise: 22 },
  ];
  const d = diffHoldings(before, after);
  assert.equal(d.added.length, 1);
  assert.equal(d.added[0].security_id, "D");
  assert.equal(d.removed.length, 1);
  assert.equal(d.removed[0].security_id, "C");
  assert.equal(d.changed.length, 1);
  assert.equal(d.changed[0].after.quantity, 12);
  assert.equal(d.unchanged, 1);
});
