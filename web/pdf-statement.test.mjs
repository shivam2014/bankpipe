import test from "node:test";
import assert from "node:assert/strict";
import { pdfToStatement } from "./pdf-statement.js";

// A text item as pdf.js reports it: baseline y, left x, rendered width.
const item = (str, x, y, width = str.length * 5) => ({ str, x, y, width });

// Right-align a money token on a column's right edge, the way banks print it.
const right = (str, edge, y) => item(str, edge - str.length * 5, y, str.length * 5);

function page2026(rows, { footer = true } = {}) {
  const items = [
    item("Branch Details", 40, 430, 70),
    item("Customer Name: ALICE", 40, 415, 120),
    item("Statement of Account:1092000100047585 For Period: 01-04-2024 to 30-04-2024", 40, 400, 400),
    item("Date", 40, 370, 20),
    item("Instrument ID", 110, 370, 65),
    item("Amount(INR)", 180, 370, 55),
    item("Type", 240, 370, 20),
    item("Balance", 280, 370, 35),
    item("Remarks", 370, 370, 35),
  ];
  for (const row of rows) {
    const y = row.y;
    items.push(item(row.date, 40, y, 45));
    if (row.ref) items.push(item(row.ref, 110, y, row.ref.length * 5));
    items.push(right(row.amount, 235, y));
    items.push(item(row.type, 240, y, 14));
    items.push(right(row.balance, 315, y));
    items.push(item(row.remark, 370, y, row.remark.length * 5));
    for (const extra of row.continuation || []) {
      items.push(item(extra, 380, y - 10, extra.length * 5));
    }
  }
  if (footer) items.push(item("Date: 30/04/2024 10:15:00 Page 1", 40, 20, 200));
  return { items };
}

function page2024(blocks) {
  const items = [];
  let y = 520;
  for (const block of blocks) {
    items.push(item(`Account Number ${block.number} ${block.name}`, 40, y, 250));
    y -= 20;
    items.push(item("Date", 40, y, 20));
    items.push(item("Particulars", 110, y, 60));
    items.push(item("Cheque No.", 270, y, 55));
    items.push(item("Withdrawal", 340, y, 60));
    items.push(item("Deposit", 410, y, 50));
    items.push(item("Balance", 470, y, 45));
    y -= 20;
    items.push(item("Opening Balance", 110, y, 75));
    items.push(right(block.opening, 515, y));
    y -= 20;
    for (const row of block.rows) {
      items.push(item(row.date, 40, y, 45));
      items.push(item(row.description, 110, y, Math.min(120, row.description.length * 5)));
      if (row.ref) items.push(item(row.ref, 270, y, 30));
      if (row.withdrawal) items.push(right(row.withdrawal, 400, y));
      if (row.deposit) items.push(right(row.deposit, 460, y));
      items.push(right(row.balance, 515, y));
      y -= 20;
    }
    items.push(item("Closing Balance", 110, y, 75));
    items.push(right(block.closing, 515, y));
    y -= 40;
  }
  return { items };
}

test("2026 layout: DR and CR signs, a wrapped remark, and the page footer ignored", () => {
  const statement = pdfToStatement([page2026([
    { date: "04/04/2024", amount: "50.00", type: "DR", balance: "3,700.00", remark: "ATM WITHDRAWAL", y: 340 },
    { date: "03/04/2024", amount: "250.00", type: "DR", balance: "3,750.00", remark: "UPI PAYMENT", y: 310,
      continuation: ["TO MERCHANT"] },
    { date: "02/04/2024", amount: "1,000.00", type: "CR", balance: "4,000.00", remark: "SALARY CREDIT", y: 280 },
  ])]);

  assert.equal(statement.scanned, false);
  assert.equal(statement.accounts.length, 1);
  const account = statement.accounts[0];
  assert.equal(account.layout, "2026");
  assert.equal(account.order, "desc");
  assert.equal(account.rows.length, 3);
  assert.deepEqual(account.rows.map((row) => row.amount), [-5000, -25000, 100000]);
  assert.deepEqual(account.rows.map((row) => row.date),
    ["2024-04-04", "2024-04-03", "2024-04-02"]);
  assert.equal(account.rows[1].description, "UPI PAYMENT TO MERCHANT");
  assert.equal(account.rows[0].source_row, 1);
  assert.equal(account.rows[2].source_row, 3);
  assert.equal(account.rows.some((row) => /page 1/i.test(row.description)), false);
  assert.deepEqual(statement.warnings, []);
});

test("2024 layout: returns the transaction block and skips a zero-row term deposit", () => {
  const statement = pdfToStatement([page2024([
    {
      number: "1234567890", name: "ALICE", opening: "1,000.00CR.", closing: "1,200.00CR.",
      rows: [
        { date: "01/04/2024", description: "SALARY", deposit: "500.00", balance: "1,500.00CR." },
        { date: "02/04/2024", description: "ATM", withdrawal: "200.00", balance: "1,300.00CR." },
        { date: "03/04/2024", description: "CHEQUE", ref: "123456", withdrawal: "100.00", balance: "1,200.00CR." },
      ],
    },
    {
      number: "TD9876543210", name: "ALICE", opening: "5,000.00CR.", closing: "5,000.00CR.",
      rows: [],
    },
  ])]);

  assert.equal(statement.scanned, false);
  assert.equal(statement.blockCount, 2);
  assert.equal(statement.accounts.length, 1);
  const account = statement.accounts[0];
  assert.equal(account.layout, "2024");
  assert.equal(account.order, "asc");
  assert.equal(account.number, "1234567890");
  assert.equal(account.opening, 100000);
  assert.equal(account.closing, 120000);
  assert.equal(account.rows.length, 3);
  assert.deepEqual(account.rows.map((row) => row.amount), [50000, -20000, -10000]);
  assert.equal(account.rows[2].ref, "123456");
  assert.deepEqual(account.rows.map((row) => row.source_row), [1, 2, 3]);
  assert.deepEqual(statement.warnings, []);
});

test("a scanned page with no text items is refused", () => {
  const statement = pdfToStatement([{ items: [], scanned: true }]);
  assert.equal(statement.scanned, true);
  assert.deepEqual(statement.accounts, []);
  assert.match(statement.warnings.join(" "), /text layer/i);
});

test("an unreadable amount is warned about and never invented", () => {
  const statement = pdfToStatement([page2024([
    {
      number: "1234567890", name: "ALICE", opening: "1,000.00CR.", closing: "1,200.00CR.",
      rows: [
        { date: "01/04/2024", description: "SALARY", deposit: "500.00", balance: "1,500.00CR." },
        { date: "02/04/2024", description: "BAD ROW", withdrawal: "1,2X4.00", balance: "1,300.00CR." },
        { date: "03/04/2024", description: "ATM", withdrawal: "100.00", balance: "1,200.00CR." },
      ],
    },
  ])]);
  const account = statement.accounts[0];
  assert.equal(account.rows.length, 2);
  assert.deepEqual(account.rows.map((row) => row.source_row), [1, 3]);
  assert.equal(account.rows.some((row) => row.amount === 0 || !Number.isInteger(row.amount)), false);
  assert.match(statement.warnings.join(" "), /no readable amount/i);
  assert.match(statement.warnings.join(" "), /closing balance/i);
});

test("a balance keeps its sign with Cr. and with a trailing currency symbol", () => {
  const statement = pdfToStatement([page2026([
    { date: "06/04/2024", amount: "50.00", type: "DR", balance: "3,950.00₹", remark: "CHARGE", y: 340 },
    { date: "05/04/2024", amount: "100.00", type: "DR", balance: "4,000.00 CR.", remark: "TRANSFER", y: 310 },
  ])]);
  const account = statement.accounts[0];
  assert.equal(account.rows.length, 2);
  assert.deepEqual(account.rows.map((row) => row.balance), [395000, 400000]);
  assert.deepEqual(account.rows.map((row) => row.amount), [-5000, -10000]);
  assert.deepEqual(statement.warnings, []);
});
