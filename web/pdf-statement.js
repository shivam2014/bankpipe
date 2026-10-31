// Browser-side PDF bank statements. pdf.js reads the text layer; this module
// rebuilds lines from text-item geometry and turns them into the same canonical
// rows the CSV/XLSX path already imports. No canvas, no OCR, no network.
//
// Two PNB layouts are known:
//   2024  Date / Particulars / Cheque No. / Withdrawal / Deposit / Balance,
//         with Opening Balance and Closing Balance around each account block.
//   2026  Date / Instrument ID / Amount(INR) / Type / Balance / Remarks,
//         with DR/CR in the Type column and no opening/closing line.

import * as pdfjs from "./vendor/pdfjs/pdf.min.mjs";
import { parseDate, parseMoney } from "./parse.js";

pdfjs.GlobalWorkerOptions.workerSrc =
  new URL("./vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;

const PAGE_PASSWORD = 1;
const INCORRECT_PASSWORD = 2;
const SCANNED_ITEMS = 20;
const COLUMN_GAP = 12;
const ROW_GAP = 2;

export class PdfPasswordError extends Error {
  constructor(message, { wrong = false, cancelled = false } = {}) {
    super(message);
    this.name = "PdfPasswordError";
    this.wrong = wrong;
    this.cancelled = cancelled;
  }
}

// Read every page's text items. A wrong password is retried once through
// onPassword; the password itself lives only in this closure.
export async function extractPdf(bytes, { password, onPassword } = {}) {
  const data = bytes instanceof Uint8Array ? new Uint8Array(bytes) : new Uint8Array(bytes);
  const hadInitial = password !== undefined && password !== null && String(password) !== "";
  let supplied = hadInitial ? String(password) : "";
  let prompts = 0;
  let failure = null;

  const task = pdfjs.getDocument({ data, password: supplied || undefined });
  task.onPassword = (updatePassword, reason) => {
    (async () => {
      const maxPrompts = hadInitial ? 1 : 2;
      if (prompts >= maxPrompts) {
        failure = new PdfPasswordError("That password did not open this PDF.", { wrong: true });
        await task.destroy();
        return;
      }
      if (!onPassword) {
        failure = new PdfPasswordError(hadInitial
          ? "That password did not open this PDF."
          : "This PDF is password protected. Enter the password the bank sent.", {
          wrong: reason === INCORRECT_PASSWORD,
        });
        await task.destroy();
        return;
      }
      prompts += 1;
      let next;
      try {
        next = await onPassword({ wrong: reason === INCORRECT_PASSWORD, reason });
      } catch (e) {
        failure = new PdfPasswordError("Password entry was cancelled.", { cancelled: true });
        await task.destroy();
        return;
      }
      if (next === null || next === undefined || String(next) === "") {
        failure = new PdfPasswordError("Password entry was cancelled.", { cancelled: true });
        await task.destroy();
        return;
      }
      supplied = String(next);
      updatePassword(supplied);
    })();
  };

  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    if (failure) throw failure;
    if (e && (e.name === "PasswordException" || e.code === PAGE_PASSWORD
        || e.code === INCORRECT_PASSWORD)) {
      throw new PdfPasswordError("That password did not open this PDF.", { wrong: true });
    }
    throw e;
  }

  const pages = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const items = [];
      for (const item of content.items || []) {
        if (!item || typeof item.str !== "string" || !item.str.trim()) continue;
        items.push({
          str: item.str,
          x: Number(item.transform?.[4]) || 0,
          y: Number(item.transform?.[5]) || 0,
          width: Number(item.width) || 0,
        });
      }
      pages.push({ items, scanned: items.length < SCANNED_ITEMS });
    }
  } finally {
    try { await doc.destroy(); } catch (e) {}
  }

  return { pages, numPages: pages.length };
}

function norm(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function collapse(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function joinItems(items) {
  if (!items.length) return "";
  let text = items[0].str.trim();
  let prev = items[0];
  for (let i = 1; i < items.length; i++) {
    const item = items[i];
    const gap = item.x - (prev.x + prev.width);
    text += (gap < 2 ? "" : " ") + item.str.trim();
    prev = item;
  }
  return collapse(text);
}

// One line is every item whose baseline is within 2 points. Cells are runs
// separated by more than 12 points, which is where a bank puts a column edge.
function buildLines(items) {
  const usable = (items || [])
    .filter((item) => item && typeof item.str === "string" && item.str.trim())
    .map((item) => ({
      str: item.str,
      x: Number(item.x) || 0,
      y: Number(item.y) || 0,
      width: Number(item.width) || 0,
    }))
    .sort((a, b) => b.y - a.y || a.x - b.x);

  const groups = [];
  for (const item of usable) {
    let group = null;
    for (const candidate of groups) {
      if (Math.abs(candidate.y - item.y) <= ROW_GAP) { group = candidate; break; }
    }
    if (!group) {
      group = { y: item.y, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  groups.sort((a, b) => b.y - a.y);

  return groups.map((group) => {
    group.items.sort((a, b) => a.x - b.x);
    const cells = [];
    let cell = null;
    for (const item of group.items) {
      const prev = cell ? cell.items[cell.items.length - 1] : null;
      const gap = prev ? item.x - (prev.x + prev.width) : 0;
      if (!cell || gap > COLUMN_GAP) {
        cell = { items: [item] };
        cells.push(cell);
      } else {
        cell.items.push(item);
      }
    }
    for (const current of cells) {
      current.x = current.items[0].x;
      current.right = Math.max(...current.items.map((item) => item.x + item.width));
      current.text = joinItems(current.items);
    }
    return {
      y: group.y,
      items: group.items,
      cells,
      text: cells.map((current) => current.text).join(" "),
    };
  });
}

function roleFor(label) {
  const key = norm(label);
  if (!key) return "text";
  if (/^date/.test(key) || key === "valuedate" || key === "txndate") return "date";
  if (/withdraw|debit/.test(key)) return "withdrawal";
  if (/deposit|credit/.test(key)) return "deposit";
  if (/balance/.test(key)) return "balance";
  if (/amount/.test(key)) return "amount";
  if (key === "type" || key === "drcr" || key === "drcrindicator" || /^type/.test(key)) return "type";
  if (/instrument|cheque|chq|^ref|reference/.test(key)) return "ref";
  if (/particular|remark|description|narration|details/.test(key)) return "description";
  return "text";
}

// Header labels sit closer together than data cells (PNB packs "Amount" and
// "Type" eight points apart), so a header column is one label item, not a
// 12-point cell. Only a label split inside a word is rejoined.
function headerCells(line) {
  const cells = [];
  for (const item of line.items) {
    const previous = cells[cells.length - 1];
    const gap = previous ? item.x - previous.right : 0;
    if (previous && gap < 4) {
      previous.items.push(item);
      previous.right = item.x + item.width;
      previous.text = joinItems(previous.items);
    } else {
      cells.push({ items: [item], x: item.x, right: item.x + item.width, text: item.str.trim() });
    }
  }
  return cells;
}

function headerColumns(line) {
  const cells = headerCells(line);
  if (!cells.length) return null;
  if (roleFor(cells[0].text) !== "date") return null;
  const columns = cells.map((cell) => ({
    label: cell.text,
    role: roleFor(cell.text),
    x: cell.x,
    right: cell.right,
    center: (cell.x + cell.right) / 2,
  }));
  const roles = new Set(columns.map((column) => column.role));
  const hasMoney = roles.has("amount") || roles.has("withdrawal") || roles.has("deposit");
  if (!hasMoney || !roles.has("balance")) return null;
  return columns;
}

function nearestByCenter(item, columns) {
  const center = item.x + item.width / 2;
  let best = null;
  let distance = Infinity;
  for (const column of columns) {
    const next = Math.abs(center - column.center);
    if (next < distance) { distance = next; best = column; }
  }
  return best;
}

const MONEY_ROLES = new Set(["withdrawal", "deposit", "amount", "balance"]);

function nearestMoneyColumn(item, columns) {
  const right = item.x + item.width;
  let best = null;
  let distance = Infinity;
  for (const column of columns) {
    if (!MONEY_ROLES.has(column.role)) continue;
    const next = Math.abs(right - column.right);
    if (next < distance) { distance = next; best = column; }
  }
  return { column: best, distance };
}

const DATE_TOKEN = new RegExp(
  "^(\\d{1,2}[\\/.-][A-Za-z]{3,9}[\\/.-]\\d{2,4}"
  + "|\\d{1,2}[\\/.-]\\d{1,2}[\\/.-]\\d{2,4}"
  + "|\\d{4}-\\d{2}-\\d{2}"
  + "|\\d{8}"
  + "|\\d{1,2}\\s+[A-Za-z]{3,9}\\s+\\d{2,4})(?=\\s|$)",
);

function dateAtStart(text) {
  const match = String(text || "").match(DATE_TOKEN);
  return match ? parseDate(match[1]) : "";
}

function isPageFooter(text) {
  return /^date\s*:\s*\d{1,2}[\/.-]\d{1,2}[\/.-]\d{4}\b.*\bpage\s+\d+/i.test(text)
    || /^page\s+\d+(\s+of\s+\d+)?$/i.test(text)
    || /^continued\b/i.test(text);
}

function isNoiseLine(text) {
  return /^[*•]/.test(text)
    || /^\(amount in\b/i.test(text)
    || /^(br|qab|ret|chq|si|trf|pos|posp)\s*:/i.test(text)
    || /^(please|unless|computer generated|this is a|the statement of account)\b/i.test(text)
    || /^(branch|ifsc|customer|name\s*&|address|joint account|mode of|deposit account summary)\b/i.test(text);
}

function blockStart(line) {
  const text = line.text.trim();
  let match = text.match(/^statement\s+of\s+account\s*:\s*([0-9A-Z][0-9A-Z\/-]*)/i);
  if (match) return { layout: "2026", number: match[1].trim(), name: "" };
  match = text.match(/^account\s+number\s*:?\s*([0-9A-Z][0-9A-Z\/-]*)(?:\s+(.*))?$/i);
  if (match) return { layout: "2024", number: match[1].trim(), name: collapse(match[2] || "") };
  return null;
}

function blockMoney(line) {
  const values = [];
  for (const item of line.items) {
    const value = parseMoney(item.str);
    if (value !== null) values.push(value);
  }
  return values.length ? values[values.length - 1] : null;
}

function lineHasMoney(line) {
  return line.items.some((item) => parseMoney(item.str) !== null);
}

function isContinuation(line, block) {
  if (!block.lastRow || block.lastPage !== line.page) return false;
  if (line.y >= block.lastRowY - 0.5) return false;
  if (block.lastRowY - line.y > 26) return false;
  const text = line.text.trim();
  if (!text || isPageFooter(text) || isNoiseLine(text)) return false;
  if (dateAtStart(text) || lineHasMoney(line)) return false;
  const dateColumn = block.columns.find((column) => column.role === "date");
  const firstX = line.items[0]?.x ?? 0;
  if (dateColumn && firstX < dateColumn.x + 30) return false;
  return true;
}

function parseRow(line, block) {
  const date = dateAtStart(line.text);
  if (!date) return null;
  const columns = block.columns || [];
  const description = [];
  const ref = [];
  const type = [];
  const other = [];
  const money = { withdrawal: [], deposit: [], amount: [], balance: [] };

  for (const item of line.items) {
    const text = item.str.trim();
    if (!text) continue;
    const column = nearestByCenter(item, columns);
    const role = column ? column.role : "text";
    if (role === "date") continue;
    if (role === "description") { description.push(text); continue; }
    if (role === "ref") { ref.push(text); continue; }
    if (role === "type") { type.push(text); continue; }
    if (MONEY_ROLES.has(role)) {
      const value = parseMoney(text);
      money[role].push(value);
      continue;
    }
    const value = parseMoney(text);
    if (value !== null) {
      const nearest = nearestMoneyColumn(item, columns);
      if (nearest.column && nearest.distance <= 80) {
        money[nearest.column.role].push(value);
        continue;
      }
    }
    other.push(text);
  }

  const last = (bucket) => (bucket.length ? bucket[bucket.length - 1] : null);
  const has = (bucket) => bucket.length > 0;
  const typeText = type.join(" ").toUpperCase();
  let amount = null;
  let amountUnreadable = false;
  let balanceUnreadable = false;

  if (has(money.amount)) {
    const value = last(money.amount);
    if (value === null) amountUnreadable = true;
    else {
      amount = Math.abs(value);
      if (/\bDR\b/.test(typeText)) amount = -amount;
      else if (!/\bCR\b/.test(typeText) && value < 0) amount = -amount;
    }
  } else if (has(money.withdrawal) || has(money.deposit)) {
    const withdrawal = last(money.withdrawal);
    const deposit = last(money.deposit);
    if ((has(money.withdrawal) && withdrawal === null)
        || (has(money.deposit) && deposit === null)) amountUnreadable = true;
    else if (withdrawal !== null && deposit !== null) {
      amount = Math.abs(deposit) - Math.abs(withdrawal);
    } else if (withdrawal !== null) {
      amount = -Math.abs(withdrawal);
    } else if (deposit !== null) {
      amount = Math.abs(deposit);
    }
  } else if (columns.length === 0) {
    const values = [];
    for (const item of line.items) {
      const value = parseMoney(item.str);
      if (value !== null) values.push({ item, value });
    }
    if (values.length >= 2) {
      const value = values[values.length - 2].value;
      amount = value < 0 ? value : (/\bDR\b/.test(typeText) ? -Math.abs(value) : Math.abs(value));
      money.balance.push(values[values.length - 1].value);
    }
  }

  const balance = has(money.balance) ? last(money.balance) : null;
  if (has(money.balance) && balance === null) balanceUnreadable = true;
  return {
    date,
    description: collapse([...description, ...other].join(" ")),
    ref: collapse(ref.join(" ")),
    amount,
    balance,
    source_row: block.rowCount,
    unreadable: amountUnreadable,
    balanceUnreadable,
    hasAmount: has(money.amount) || has(money.withdrawal) || has(money.deposit),
  };
}

function reconciliation(block, warnings, label) {
  const rows = block.rows;
  if (!rows.length) return;
  const dated = rows.filter((row) => row.amount !== null && row.date);
  if (!dated.length) return;
  const order = (() => {
    if (dated.length < 2) return "desc";
    const first = dated[0].date;
    const last = dated[dated.length - 1].date;
    return first > last ? "desc" : first < last ? "asc" : "desc";
  })();
  block.order = order;
  const chrono = order === "desc" ? rows.slice().reverse() : rows.slice();

  if (block.closing !== null) {
    if (block.opening !== null) {
      let balance = block.opening;
      let breaks = 0;
      for (const row of chrono) {
        if (row.amount === null) continue;
        balance += row.amount;
        if (row.balance !== null && Math.abs(balance - row.balance) > 1) breaks += 1;
      }
      if (breaks) {
        warnings.push(`${label}: ${breaks} row${breaks === 1 ? "" : "s"} do not follow the running balance.`);
      }
      if (Math.abs(balance - block.closing) > 1) {
        warnings.push(`${label}: the rows do not reconcile with the printed closing balance.`);
      }
    } else {
      const lastRow = rows[rows.length - 1];
      if (lastRow && lastRow.balance !== null
          && Math.abs(lastRow.balance - block.closing) > 1) {
        warnings.push(`${label}: the rows do not reconcile with the printed closing balance.`);
      }
    }
  }

  if (block.closing === null && rows.length > 1) {
    let breaks = 0;
    for (let i = 0; i < rows.length - 1; i++) {
      const current = rows[i];
      const next = rows[i + 1];
      if (current.amount === null || current.balance === null || next.balance === null) continue;
      if (Math.abs(current.balance - current.amount - next.balance) > 1) breaks += 1;
    }
    if (breaks) {
      warnings.push(`${label}: ${breaks} row${breaks === 1 ? "" : "s"} do not follow the running balance.`);
    }
  }
}

export function pdfToStatement(pages) {
  const list = Array.isArray(pages) ? pages : [];
  const totalItems = list.reduce((sum, page) => sum + ((page?.items || []).length), 0);
  const allScanned = list.length > 0
    && list.every((page) => page?.scanned || (page?.items || []).length < SCANNED_ITEMS);
  const scanned = !list.length || totalItems < SCANNED_ITEMS || allScanned;

  const lines = [];
  list.forEach((page, pageIndex) => {
    for (const line of buildLines(page?.items || [])) lines.push({ ...line, page: pageIndex });
  });

  const warnings = [];
  const blocks = [];
  let current = null;

  for (const line of lines) {
    const text = line.text.trim();
    if (!text) continue;
    if (isPageFooter(text)) continue;

    const start = blockStart(line);
    if (start) {
      current = {
        layout: start.layout,
        number: start.number,
        name: start.name,
        header: null,
        columns: [],
        opening: null,
        closing: null,
        rows: [],
        rowCount: 0,
        lastRow: null,
        lastRowY: 0,
        lastPage: -1,
        order: "desc",
      };
      blocks.push(current);
      continue;
    }
    if (!current) continue;

    const columns = headerColumns(line);
    if (columns) {
      current.header = line;
      current.columns = columns;
      continue;
    }
    if (/^opening\s+balance\b/i.test(text)) {
      current.opening = blockMoney(line);
      if (current.opening === null) warnings.push("Opening balance could not be read.");
      continue;
    }
    if (/^closing\s+balance\b/i.test(text)) {
      current.closing = blockMoney(line);
      if (current.closing === null) warnings.push("Closing balance could not be read.");
      continue;
    }
    if (!current.columns.length) continue;
    if (isNoiseLine(text)) continue;

    if (dateAtStart(text)) {
      current.rowCount += 1;
      const row = parseRow(line, current);
      if (!row) continue;
      if (row.unreadable || row.amount === null) {
        warnings.push(`Row ${row.source_row} has no readable amount; it was skipped.`);
        continue;
      }
      if (row.balanceUnreadable) {
        warnings.push(`Row ${row.source_row} has no readable balance.`);
      }
      current.rows.push({
        date: row.date,
        description: row.description,
        ref: row.ref,
        amount: row.amount,
        balance: row.balance,
        source_row: row.source_row,
      });
      current.lastRow = row;
      current.lastRowY = line.y;
      current.lastPage = line.page;
      continue;
    }

    if (isContinuation(line, current)) {
      const previous = current.rows[current.rows.length - 1];
      if (previous) previous.description = collapse(`${previous.description} ${text}`);
    }
  }

  const summaries = [];
  const accounts = [];
  for (const block of blocks) {
    const label = `Block ${summaries.length + 1}`;
    const hasData = block.rows.length > 0 || block.opening !== null || block.closing !== null;
    const emptyShell = block.rows.length === 0 && block.opening === 0 && block.closing === 0;
    if (!hasData || emptyShell) continue;
    reconciliation(block, warnings, label);
    summaries.push({
      number: block.number,
      name: block.name,
      layout: block.layout,
      opening: block.opening,
      closing: block.closing,
      rows: block.rows.length,
      order: block.order,
    });
    if (block.rows.length) {
      accounts.push({
        number: block.number,
        name: block.name,
        opening: block.opening,
        closing: block.closing,
        rows: block.rows,
        layout: block.layout,
        order: block.order,
      });
    }
  }

  if (scanned) warnings.unshift("No text layer was found. A scanned or photographed statement cannot be read.");
  else if (!blocks.length) warnings.push("No account block was found in the PDF text layer.");

  return {
    accounts,
    blocks: summaries,
    blockCount: summaries.length,
    warnings,
    scanned,
    numPages: list.length,
  };
}
