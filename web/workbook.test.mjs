import test from "node:test";
import assert from "node:assert/strict";
import {
  colIndex, classifyAmountHeader, parseTransactions, parseHoldings, parseSheet,
  profileFor, parseRegister, classifyRegisterCategory, applyAssetPlan, safeId,
} from "./workbook.js";
import { readFileSync } from "node:fs";

test("column letters become zero-based indexes", () => {
  assert.equal(colIndex("A"), 0);
  assert.equal(colIndex("F"), 5);
  assert.equal(colIndex("AA"), 26);
  assert.equal(colIndex(""), -1);
});

test("local header words identify debit, credit and balance", () => {
  assert.equal(classifyAmountHeader("Withdrawal Amount (INR )"), "debit");
  assert.equal(classifyAmountHeader("Deposit Amount (INR )"), "credit");
  assert.equal(classifyAmountHeader("Balance (INR )"), "balance");
  assert.equal(classifyAmountHeader("DR"), "debit");
  assert.equal(classifyAmountHeader("CR"), "credit");
  assert.equal(classifyAmountHeader("Amount"), "amount");
  assert.equal(classifyAmountHeader(""), "");
});

const sheet5 = {
  i: 5, purpose: "transactions", importable: true, header_row: 5,
  columns: [
    { col: "B", kind: "date", role: "value" },
    { col: "C", kind: "free_text", role: "label" },
    { col: "D", kind: "amount", role: "value" },
    { col: "E", kind: "amount", role: "value" },
    { col: "F", kind: "amount", role: "value" },
  ],
};
const matrix5 = [
  ["Statement of account"],
  ["Account: redacted"],
  [],
  [],
  ["S No.", "Value Date", "Transaction Remarks", "Withdrawal Amount (INR )",
    "Deposit Amount (INR )", "Balance (INR )"],
  ["1", "01/04/2024", "UPI-SWIGGY", "1,250.00", "", "1,00,000.00"],
  ["2", "02/04/2024", "SALARY", "", "50,000.00", "1,50,000.00"],
  ["", "", "TOTAL", "1,250.00", "50,000.00", "1,50,000.00"],
];

test("a bank statement becomes signed facts with a balance", () => {
  const out = parseTransactions(matrix5, sheet5);
  assert.equal(out.rows.length, 2);
  assert.equal(out.rows[0].amount, -125000);
  assert.equal(out.rows[0].balance, 10000000);
  assert.equal(out.rows[1].amount, 5000000);
  assert.equal(out.rows[0].date, "2024-04-01");
  assert.equal(out.rows[0].description, "UPI-SWIGGY");
});

test("a total row without a date is skipped", () => {
  const out = parseTransactions(matrix5, sheet5);
  assert.equal(out.rows.length, 2);
  assert.ok(out.skipped >= 1);
});

const sheet4 = {
  i: 4, purpose: "transactions", importable: true, header_row: 1,
  columns: [
    { col: "B", kind: "date", role: "value" },
    { col: "C", kind: "free_text", role: "label" },
    { col: "D", kind: "amount", role: "value" },
    { col: "E", kind: "amount", role: "value" },
    { col: "F", kind: "amount", role: "value" },
  ],
};
const matrix4 = [
  ["No", "Txn Date", "Description", "DR", "CR", "Amount"],
  ["1", "03/04/2024", "ATM", "2,000.00", "", "-2,000.00"],
  ["2", "04/04/2024", "REFUND", "", "500.00", "500.00"],
];

test("a DR/CR/Amount sheet uses the signed amount column", () => {
  const out = parseTransactions(matrix4, sheet4);
  assert.equal(out.rows.length, 2);
  assert.equal(out.rows[0].amount, -200000);
  assert.equal(out.rows[1].amount, 50000);
});

test("without header words, two amount columns are debit then credit", () => {
  const sheet = { ...sheet4, columns: sheet4.columns.slice(0, 4) };
  const matrix = [
    ["No", "Txn Date", "Description", "", ""],
    ["1", "03/04/2024", "ATM", "2,000.00", ""],
    ["2", "04/04/2024", "REFUND", "", "500.00"],
  ];
  const out = parseTransactions(matrix, sheet);
  assert.equal(out.rows[0].amount, -200000);
  assert.equal(out.rows[1].amount, 50000);
});

const holdingsSheet = {
  i: 2, purpose: "holdings", importable: true, header_row: 1,
  columns: [
    { col: "C", kind: "security_id", role: "key" },
    { col: "D", kind: "security_name", role: "label" },
    { col: "E", kind: "date", role: "value" },
    { col: "F", kind: "date", role: "value" },
    { col: "G", kind: "category", role: "grouping" },
    { col: "H", kind: "quantity", role: "value" },
    { col: "I", kind: "amount", role: "value" },
  ],
};
const holdingsMatrix = [
  ["", "", "ISIN", "Security Name", "Purchase Date", "Interest Payment Date",
    "Rating", "Quantity", "Total Cost Price"],
  ["", "", "INE002A01018", "Reliance", "01/04/2024", "01/10/2024", "AA", "10",
    "1,25,000.00"],
  ["", "", "INE008A01015", "REC Bond", "02/04/2024", "", "AAA", "5", "50,000.00"],
  ["", "", "", "", "", "", "", "", ""],
];

test("a holdings register keeps identity, quantity and cost", () => {
  const out = parseHoldings(holdingsMatrix, holdingsSheet);
  assert.equal(out.rows.length, 2);
  assert.equal(out.rows[0].security_id, "INE002A01018");
  assert.equal(out.rows[0].quantity, 10);
  assert.equal(out.rows[0].cost_paise, 12500000);
  assert.equal(out.rows[0].purchase_date, "2024-04-01");
  assert.equal(out.rows[0].category, "AA");
});

test("a sheet the profile marks not importable is refused, not guessed", () => {
  const out = parseSheet([["anything"]], { purpose: "credentials", importable: false });
  assert.equal(out.rows.length, 0);
  assert.match(out.error, /not importable/);
});

test("the profile is looked up by sheet index", () => {
  const profile = { sheets: [{ i: 2, purpose: "holdings" }, { i: 5, purpose: "transactions" }] };
  assert.equal(profileFor(profile, "5").purpose, "transactions");
  assert.equal(profileFor(profile, 9), null);
});

test("profile asset and account ids are valid only in the app's own shape", () => {
  assert.equal(safeId("holdings-3"), "holdings-3");
  assert.equal(safeId("foreign_8"), "foreign_8");
  assert.equal(safeId("x".repeat(64)), "x".repeat(64));
  // A path, whitespace, quotes or markup must never become an account id.
  for (const bad of ["../../etc/passwd", "id with space", "x".repeat(65),
    '"><img src=x onerror=alert(1)>', "a/b", "a.b", "a:b", "'"]) {
    assert.equal(safeId(bad), "", bad);
    assert.equal(safeId(bad, "holdings-8"), "holdings-8", bad);
  }
  assert.equal(safeId(null, "holdings-8"), "holdings-8");
  assert.equal(safeId(undefined, "holdings-8"), "holdings-8");
});

test("a blank date with an amount carries the previous date", () => {
  const sheet = { header_row: 1, columns: [
    { col: "A", kind: "date", role: "value" },
    { col: "B", kind: "free_text", role: "label" },
    { col: "C", kind: "amount", role: "value" },
  ] };
  const matrix = [
    ["Date", "Desc", "Amount"],
    ["01/04/2024", "A", "-100.00"],
    ["", "B", "-200.00"],
    ["5", "C", "-300.00"],
  ];
  const out = parseTransactions(matrix, sheet);
  assert.equal(out.rows[1].date, "2024-04-01");
  assert.equal(out.rows[1].date_carried, true);
  assert.equal(out.rows[2].date, "2024-04-01");
  assert.equal(out.rows[2].date_carried, true);
});

test("a register row becomes an asset record", () => {
  const sheet = { purpose: "register", header_row: 1, columns: [
    { col: "A", kind: "account_ref", role: "key" },
    { col: "B", kind: "amount", role: "value" },
    { col: "C", kind: "security_id", role: "value" },
    { col: "D", kind: "category", role: "grouping" },
    { col: "E", kind: "free_text", role: "label" },
  ] };
  const matrix = [
    ["Bank", "Amount", "Number", "Category", "Description"],
    ["SBI", "1,00,000.00", "FD123", "FD", "SBI FD 3 years"],
    ["LIC", "25,000.00", "P456", "Insurance", "LIC policy"],
  ];
  const out = parseRegister(matrix, sheet);
  assert.equal(out.rows.length, 2);
  assert.equal(out.rows[0].number, "FD123");
  assert.equal(out.rows[0].amount_paise, 10000000);
  assert.equal(classifyRegisterCategory("FD"), "fd");
  assert.equal(classifyRegisterCategory("LIC policy"), "insurance");
  assert.equal(classifyRegisterCategory("AA"), "other");
});

test("debit/credit win over a single amount column, with F as fallback", () => {
  const sheet = { header_row: 1, columns: [
    { col: "A", kind: "date", role: "value" },
    { col: "B", kind: "free_text", role: "label" },
    { col: "D", kind: "amount", role: "value", use: "debit" },
    { col: "E", kind: "amount", role: "value", use: "credit" },
    { col: "F", kind: "amount", role: "value", use: "amount" },
  ] };
  const matrix = [
    ["Date", "Desc", "", "DR", "CR", "Amount"],
    ["01/04/2024", "debit", "", "1,000.00", "", "9,999.00"],
    ["02/04/2024", "credit", "", "", "2,000.00", "9,999.00"],
    ["03/04/2024", "fallback", "", "", "", "3,000.00"],
  ];
  const out = parseTransactions(matrix, sheet);
  assert.equal(out.rows[0].amount, -100000);
  assert.equal(out.rows[1].amount, 200000);
  assert.equal(out.rows[2].amount, 300000);
});


test("the register maps description, amount, start, number, maturity and rate", () => {
  const matrix = [
    ["Description", "Amount", "Date of Commencement", "Policy No.", "Extras",
      "Bank Details", "Contact", "Recurring", "Date", "Amt Paid",
      "Date of Payment Last", "Amt Paid"],
    ["SCB FD 900000001", "250,000.00", "Issue 22/11/2025", "SCB FD 900000001",
      "", "Maturity:27/11/2026", "375 days @7.50", "250000", "250000", "250000", "", ""],
    ["LIC policy", "300000", "23.07.2021", "900000002", "Premium 4.5%", "PAID",
      "Policy upto July 2042", "50896.2", "", "0", "", "0"],
    ["PUNJAB NATIONAL BANK", "", "", "", "", "", "", "", "", "", "", ""],
    ["Login : DEMO00000001", "", "", "", "", "", "", "", "", "", "", ""],
    ["TOTAL", "", "", "", "", "", "", "", "", "", "", ""],
  ];
  const out = parseRegister(matrix, { purpose: "register", header_row: 1 });
  assert.equal(out.rows.length, 2);
  const fd = out.rows[0];
  assert.equal(fd.label, "Standard Chartered FD 0001");
  assert.equal(fd.number, "900000001");
  assert.equal(fd.amount_paise, 25000000);
  assert.equal(fd.start_date, "2025-11-22");
  assert.equal(fd.maturity_date, "2026-11-27");
  assert.equal(fd.rate_bps, 750);
  assert.equal(fd.category, "fd");
  assert.equal(fd.institution, "Standard Chartered");
  const policy = out.rows[1];
  assert.equal(policy.category, "insurance");
  assert.equal(policy.number, "900000002");
  assert.equal(policy.sum_assured_paise, 30000000);
  assert.equal(policy.premium_paise, 5089620);
  assert.equal(policy.maturity_date, "2042-07-01");
});

test("a holdings sheet uses the second amount column as current value", () => {
  const sheet = { purpose: "holdings", header_row: 1, columns: [
    { col: "C", kind: "security_id", role: "key" },
    { col: "D", kind: "security_name", role: "label" },
    { col: "E", kind: "date", role: "value" },
    { col: "F", kind: "date", role: "value" },
    { col: "G", kind: "category", role: "grouping" },
    { col: "H", kind: "quantity", role: "value" },
    { col: "I", kind: "amount", role: "value" },
    { col: "J", kind: "amount", role: "value" },
  ] };
  const matrix = [
    ["", "", "ISIN", "Security Name", "Purchase", "Interest", "Rating", "Qty",
      "Cost", "Value"],
    ["", "", "INE000000001", "A bond", "2024-01-01", "2026-01-01", "AA", "1",
      "1,00,000", "1,05,000"],
  ];
  const out = parseHoldings(matrix, sheet);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].cost_paise, 10000000);
  assert.equal(out.rows[0].value_paise, 10500000);
});

test("the workbook profile points at the verified columns", () => {
  const profile = JSON.parse(readFileSync(
    new URL("./profiles/family-workbook.json", import.meta.url), "utf8"));
  const by = new Map(profile.sheets.map((s) => [s.i, s]));
  assert.equal(by.get(4).columns.find((c) => c.col === "F").use, "balance");
  assert.equal(by.get(2).columns.some((c) => c.col === "J"), true);
  assert.equal(by.get(3).columns.some((c) => c.col === "J"), true);
  assert.equal(by.get(0).importable, false);
  for (const i of [8, 9, 10]) {
    assert.equal(by.get(i).purpose, "transactions");
    assert.equal(by.get(i).importable, true);
  }
  assert.equal(by.get(7).importable, true);
  assert.equal(by.get(7).currency, "INR");
  assert.equal(by.get(7).columns.find((c) => c.col === "C").use, "debit");
});

test("a stray date with no amount, balance or description is not a transaction", () => {
  const sheet = { header_row: 1, columns: [
    { col: "A", kind: "date", role: "value" },
    { col: "B", kind: "free_text", role: "label" },
    { col: "C", kind: "amount", role: "value", use: "amount" },
    { col: "D", kind: "amount", role: "value", use: "balance" },
  ] };
  const matrix = [
    ["Date", "Description", "Amount", "Balance"],
    ["2024-04-01", "A", "100", "1100"],
    ["2025-01-01", "", "", ""],
  ];
  const out = parseTransactions(matrix, sheet);
  assert.equal(out.rows.length, 1);
  assert.equal(out.skipped, 1);
});

test("a maturity date repeated in two free-text cells is accepted", () => {
  const matrix = [
    ["Description", "Amount", "Date of Commencement", "Policy No.", "Extras",
      "Bank Details", "Contact", "Recurring", "Date", "Amt Paid",
      "Date of Payment Last", "Amt Paid"],
    ["ICICI FD 900000003", "350000", "", "900000003", "", "FD matures 2027-10-19",
      "", "", "", "350000", "2027-10-19", "350000"],
  ];
  const out = parseRegister(matrix, { purpose: "register", header_row: 1 });
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].category, "fd");
  assert.equal(out.rows[0].maturity_date, "2027-10-19");
});

test("an insurance label keeps the product, not the URL or policy prose", () => {
  const matrix = [
    ["Description", "Amount", "Date of Commencement", "Policy No.", "Extras",
      "Bank Details", "Contact", "Recurring", "Date", "Amt Paid",
      "Date of Payment Last", "Amt Paid"],
    ["PNBMETIFE KAVITA MEHTA Policy Name :PNB MetLife Endowment Savings+ https://example.com/very/long/url?token=abc Issue 26 March 2018",
      "100000", "Issue 26 March 2018", "900000003", "Policy Document: 900000003",
      "PAID", "maturity 26.03.2028", "10000", "", "", "", ""],
  ];
  const out = parseRegister(matrix, { purpose: "register", header_row: 1 });
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].category, "insurance");
  assert.equal(out.rows[0].number, "900000003");
  assert.equal(out.rows[0].label.includes("http"), false);
  assert.equal(out.rows[0].label.includes("KAVITA"), false);
  assert.match(out.rows[0].label, /PNB MetLife/);
  assert.match(out.rows[0].label, /0003/);
});

test("an FD without a bank name inherits the section heading", () => {
  const matrix = [
    ["Description", "Amount", "Date of Commencement", "Policy No.", "Extras",
      "Bank Details", "Contact", "Recurring", "Date", "Amt Paid",
      "Date of Payment Last", "Amt Paid"],
    ["PUNJAB NATIONAL BANK", "", "", "", "", "", "", "", "", "", "", ""],
    ["999900DP00000001", "8,06,771.00", "", "999900DP00000001", "", "2026-12-05",
      "", "", "", "", "", ""],
  ];
  const out = parseRegister(matrix, { purpose: "register", header_row: 1 });
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].institution, "PNB");
  assert.equal(out.rows[0].label, "PNB FD 0001");
});

test("a date cell written as 5-Dec-26 is read as maturity", () => {
  const matrix = [
    ["Description", "Amount", "Date of Commencement", "Policy No.", "Extras",
      "Bank Details", "Contact", "Recurring", "Date", "Amt Paid",
      "Date of Payment Last", "Amt Paid"],
    ["PUNJAB NATIONAL BANK", "", "", "", "", "", "", "", "", "", "", ""],
    ["999900DP00000001", "8,06,771.00", "", "999900DP00000001", "", "5-Dec-26",
      "", "", "", "", "", ""],
  ];
  const out = parseRegister(matrix, { purpose: "register", header_row: 1 });
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].category, "fd");
  assert.equal(out.rows[0].maturity_date, "2026-12-05");
});

test("a Bonsai section plan becomes assets, not one asset per sheet row", () => {
  const plan = { sections: [
    { kind: "insurance", first_row: 2, last_row: 2, institution: "LIC",
      number_col: "D", principal_col: "B", start_col: "C", maturity_col: "G",
      rate_col: "E", notes_col: "E" },
    { kind: "fd", first_row: 3, last_row: 3, institution: "PNB",
      number_col: "A", principal_col: "B", start_col: "C", maturity_col: "F",
      rate_col: "E", notes_col: "E" },
    { kind: "gold", first_row: 4, last_row: 4, institution: "Jeweller",
      number_col: "D", principal_col: "B", start_col: "C", maturity_col: "G",
      rate_col: "E", notes_col: "E" },
  ] };
  const matrix = [
    ["Description", "Amount", "Date of Commencement", "Policy No.", "Extras",
      "Bank Details", "Contact", "Recurring", "Date", "Amt Paid",
      "Date of Payment Last", "Amt Paid"],
    ["LIC policy", "300000", "23.07.2021", "900000002", "Premium 4.5%", "PAID",
      "Policy upto July 2042", "50896.2", "", "0", "", "0"],
    ["999900DP00000001", "8,06,771.00", "", "999900DP00000001", "", "5-Dec-26",
      "", "", "", "", "", ""],
    ["GOLD Purchase GRT", "100000", "10.07.2020", "", "", "", "", "", "", "", "", ""],
  ];
  const out = applyAssetPlan(matrix, plan);
  assert.equal(out.rows.length, 3);
  assert.equal(out.rows[0].category, "insurance");
  assert.equal(out.rows[0].maturity_date, "2042-07-01");
  assert.equal(out.rows[1].category, "fd");
  assert.equal(out.rows[1].maturity_date, "2026-12-05");
  assert.equal(out.rows[2].category, "gold");
  assert.equal(out.rows[2].amount_paise, 10000000);
  assert.equal(out.rows[2].maturity_date, "");
});

test("the committed section plan has no values and covers the register blocks", () => {
  const plan = JSON.parse(readFileSync(
    new URL("./profiles/family-assets-plan.json", import.meta.url), "utf8"));
  assert.equal(plan.sheet_index, 1);
  assert.equal(plan.sections.length, 10);
  const kinds = plan.sections.map((s) => s.kind);
  assert.ok(kinds.includes("insurance"));
  assert.ok(kinds.includes("fd"));
  assert.ok(kinds.includes("demat"));
  assert.ok(kinds.includes("gold"));
  for (const s of plan.sections) {
    assert.ok(s.first_row >= 2 && s.last_row >= s.first_row);
    assert.equal(/^[A-L]$/.test(s.number_col || "A"), true);
  }
});

test("a date-formatted Amount cell keeps its raw value in the section plan", () => {
  const plan = { sections: [{ kind: "fd", first_row: 2, last_row: 2,
    institution: "PNB", number_col: "A", principal_col: "B", start_col: "C",
    maturity_col: "F", rate_col: "E", notes_col: "E" }] };
  const matrix = [
    ["Description", "Amount", "Date of Commencement", "Policy No.", "Extras",
      "Bank Details", "Contact", "Recurring", "Date", "Amt Paid"],
    [",9999005500876421", "30-May-11", "", "", "", "16.05.2031", "", "", "", ""],
  ];
  const rawMatrix = [
    ["Description", "Amount", "Date of Commencement", "Policy No.", "Extras",
      "Bank Details", "Contact", "Recurring", "Date", "Amt Paid"],
    [",9999005500876421", 40693, "", "", "", "16.05.2031", "", "", "", ""],
  ];
  const out = applyAssetPlan(matrix, plan, rawMatrix);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].amount_paise, 4069300);
});

test("a date-formatted Amount cell keeps its raw value in the register parser", () => {
  const matrix = [
    ["Description", "Amount", "Date of Commencement", "Policy No.", "Extras",
      "Bank Details", "Contact", "Recurring", "Date", "Amt Paid"],
    ["PNB FD 8010", "30-May-11", "", "9999005500876421", "", "16.05.2031",
      "", "", "", ""],
  ];
  const rawMatrix = [
    ["Description", "Amount", "Date of Commencement", "Policy No.", "Extras",
      "Bank Details", "Contact", "Recurring", "Date", "Amt Paid"],
    ["PNB FD 8010", 40693, "", "9999005500876421", "", "16.05.2031",
      "", "", "", ""],
  ];
  const out = parseRegister(matrix, { purpose: "register", header_row: 1 }, rawMatrix);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].amount_paise, 4069300);
});

test("an insurance plan counts premiums paid, not the recurring premium or cover", () => {
  const plan = { sections: [{ kind: "insurance", first_row: 2, last_row: 3,
    institution: "LIC", number_col: "D", principal_col: "B", start_col: "C",
    maturity_col: "G", rate_col: "E", notes_col: "E" }] };
  const matrix = [
    ["Description", "Amount", "Date of Commencement", "Policy No.", "Extras",
      "Bank Details", "Contact", "Recurring", "Date", "Amt Paid",
      "Date of Payment Last", "Amt Paid"],
    ["LIC policy 1", "300000", "23.07.2021", "900000002", "Premium 4.5%", "PAID",
      "Policy upto July 2042", "50896.2", "34054.6", "0", "", "0"],
    ["LIC policy 2", "122700", "23.07.2021", "900000003", "Premium 4.5%", "PAID",
      "Policy upto July 2042", "", "", "858900", "", "858900"],
  ];
  const out = applyAssetPlan(matrix, plan);
  assert.equal(out.rows[0].premium_paise, 3405460);
  assert.equal(out.rows[0].sum_assured_paise, 30000000);
  assert.equal(out.rows[1].premium_paise, 85890000);
  assert.equal(out.rows[1].sum_assured_paise, null);
});
