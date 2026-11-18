# Parser robustness: names, not positions

The import inbox accepts files the app does not control. A parser that reads a
column by position turns a harmless syntax change into a wrong import: a renamed
"Qty" becomes a missing holding, a shifted column becomes a price in the
quantity slot. The rule is the opposite: every column is found by a name, every
unreadable value is a refusal that names the file, the table, the column and the
row, and nothing is guessed.

## The rules

1. **No parser reads a column by position.** A column index comes only from a
   header name resolved through an alias table.
2. **Aliases are data.** Each family declares its fields and spellings beside
   the parser. A new spelling is one list entry plus a test.
3. **Fail closed with a name.** A missing required column, a header that cannot
   be read, or a non-empty cell that is not a number or a date refuses the file.
   A blank cell is blank, not zero; an explicit no-value marker (`--`, `N/A`,
   `nil`) is blank.
4. **A row is never dropped silently.** A closed position (zero quantity) is
   counted, not hidden. A row whose identity is unreadable is counted, and an
   empty result names the likely renamed column.
5. **Dates have one ambiguity rule.** A numeric date whose first two parts both
   fit a month is read day-first (the Indian convention) and reported as
   ambiguous. A part above 12 settles the order. Two-digit years 00-79 are
   2000-2079 and 80-99 are 1980-1999. An impossible calendar day is refused.

The layer is `web/table-schema.js`. Its tests are `web/table-schema.test.mjs`;
the cross-family matrix is `web/parser-robustness.test.mjs`.

## Audit

The third reported failure, a coupon hidden in a dashed bond name
(`TESTD-11.90%-3-12-26`), was fixed before this pass at `21ebc70` and is
covered by `bonds.test.mjs` ("reads the coupon and maturity out of a dashed
broker name"). `bonds.js` is not changed here; its label reading is not a
table parser and already fails closed with `dateUnread` when a dashed date
has an impossible day.

| Parser | Assumption found | Real-file risk | Test that catches it |
|---|---|---|---|
| `zerodha.js` `holdingsColumns` (before) | The detection path in `import-flow.js` demanded the literal `quantity available` and `isin`; the parser itself demanded `quantityavailable`. | A Kite Console workbook that prints `Qty`, `Quantity` or `Avg Price` was rejected as "not a Zerodha holdings export" even though every row was readable. This is the reported Kite failure. | `a Kite workbook whose quantity column says Qty is still a holdings export`; `zerodha holdings: reordered, renamed, extra column and CSV/XLSX agree` |
| `zerodha.js` row loop (before) | `num(qty) || 0`, `num(avg)` and `continue` on a bad value dropped a row without saying so. | A cell like `7O` or a renamed price column silently removed a holding from net worth. | `zerodha holdings: an unreadable quantity refuses the file by row and column` |
| `import-flow.js` `parseTradebookRows` (before) | `continue` on an unreadable date, quantity or price; type matched by `/buy/` so `B` was not a buy. | A tradebook whose date format or quantity format changed imported a partial history, or no purchase date at all. | `tradebook: an unreadable trade type or price refuses instead of dropping the row` |
| `import-flow.js` `parseTradebookRows` (before) | CSV price read as paise, XLSX price as rupees converted; the two paths could disagree. | The same tradebook exported twice produced different cost bases. | `tradebook: reordered, renamed, extra column and CSV/XLSX agree` (asserts identical rows and paise) |
| `digifinn-reports.js` `headerIndex` (before) | Exact normalised names `isin`, `bond name`, `qty`; anything else returned `null` and the file fell through as "unknown". | Renaming `Qty` to `Quantity` or `Investment Value` to `Invested Amount` made a valid portfolio report unreadable with no explanation. | `digifinn portfolio: a renamed qty column reads, a removed one refuses`; matrix test |
| `digifinn-reports.js` rows (before) | `parseAnyDate` and `parseNumber` returned empty/null on an unreadable cell and the row was kept. | A malformed purchase date or coupon vanished into an empty field instead of being questioned. | `digifinn portfolio` and `investment` refusal tests; matrix tests |
| `digifinn.js` `parsePayouts` (before) | `findIndex(isPayouts)` required the exact `isin` and `units` names and returned `null` otherwise. | A renamed units column turned the payouts report into an unknown file. | `digifinn payouts: a removed units column refuses by name`; matrix test |
| `motilal.js` `roleFor` (before) | Column roles were regex branches in code, not an alias table; a new printed spelling needed a code edit. | A report that printed "Units" instead of "Qty" would lose the quantity column. | `motilal: a renamed quantity header, an extra column and item order agree` |
| `motilal.js` `parseSection` (before) | A section with a header but no usable quantity or amount column returned `[]`, and the file still reported success with fewer rows. | A changed section header imported only part of the portfolio. | `motilal: a header with neither quantity nor amount refuses the section by name` |
| `motilal.js` `rowFromBand` | A band could map two numbers to one role and `parseAmount` would fuse `10` and `1,00,000` into `10100000` by reading the space as grouping. | A wide or misaligned number cell created a holding with a hundredfold quantity. | `motilal: two numbers in one column refuse instead of fusing into a value` |
| `digifinn.js` `parseCashflow` | Reads `values[c+1]`, `values[c+2]` and `invest[c+1]`, `invest[c+3]` relative to each `Yield` group start. | A column inserted inside a cashflow group shifts frequency, maturity or investment date. **Still positional; not changed in this pass.** | Not covered by the matrix; see "Remaining assumptions". |
| `cas.js` | Geometry: a number is assigned to the last header column whose x is left of its right edge; a bond/equity value is the rightmost money column "whatever the header calls it". | A new rightmost money column could be read as value. Documented fragility; the printed Grand Total check catches a wrong sum. | Existing `cas-*` tests; `casTotals` refuses a mismatch. Not rewritten by design. |
| `parse.js` `findHeader` | A fallback for a hand-kept passbook reads `debit-2`, `debit-1`, `credit+1` when date and description are unlabelled. | A sheet with labelled Debit/Credit but a different layout could read the wrong columns. Guarded: it only runs when the labelled pass fails the three-name threshold, and the comment names the case. | `parse.test.mjs` headerless-sheet tests |
| `parse.js` `auditStatement` | Scans the first four preamble rows for `number CR/DR`. | A closing balance elsewhere is missed; the result is an audit flag, never imported data. | `parse.test.mjs` audit tests |
| `holding-import.js` `parseHoldingsMatrix` (before) | Permissive prefix/suffix matching assigned a field to the first column that looked like it; unreadable numbers became `null`. | "Quantity Discrepant" or a junk cell could be read or dropped without a word. | `generic holdings: an unreadable quantity refuses by column and row`; matrix test |

## The layer

`web/table-schema.js` exports:

- `resolveColumns(cells, schema)` and `findHeaderRow(rows, schema)`: one row to
  one column per field. Each field lists `aliases` in priority order; a field
  may be `required`; `loose` accepts a header that starts or ends with an alias
  (used only by the generic holdings sheet, where `Quantity (Units)` and
  `Holding Quantity` are expected, and never by Kite, where `Quantity
  Discrepant` must not stand in for `Quantity`).
- `readNumber`, `readMoney`, `readDate`: a cell or a `RefusalError`. A blank is
  allowed unless the field is required; a non-empty unreadable cell always
  refuses.
- `parseAmount`, `normaliseNumber`, `parseDate`, `parseDateDetail`: the shared
  normalisers. `parseDateDetail` returns `{iso, ambiguous, order}` so a caller
  can report a day-first choice it had to make.
- `headerMessage`, `refusalOf`, `tableWhere`: one phrasing for every refusal, so
  a screen can print `kite.xlsx → Equity, row 7: "Quantity Available" is not a
  number ("7O").`

`holding-import.js` re-exports the date and number readers, so Motilal,
DigiFInn and the inbox all read the same shapes through one implementation.

## Alias tables

| Family | Where | Fields |
|---|---|---|
| Zerodha holdings | `zerodha.js` `ZERODHA_HOLDINGS_SCHEMA` | ISIN, Quantity Available, Average Price, Symbol, Sector, Long Term, both pledged columns, Previous Close, P&L |
| Zerodha tradebook | `import-flow.js` `TRADEBOOK_SCHEMA` | Trade Date, Trade Type, Quantity, Price, ISIN, Symbol |
| DigiFInn portfolio / investment / transactions | `digifinn-reports.js` `PORTFOLIO_SCHEMA`, `INVESTMENT_SCHEMA`, `TRANSACTIONS_SCHEMA` | ISIN, Bond Name, Qty, Investment Value; Issuer, Coupon, Yield, Maturity, Invested; Transaction Type, Quantity, Price, Total/Face Value, Coupon, Maturity |
| DigiFInn payouts | `digifinn.js` `PAYOUTS_SCHEMA` (and a stricter `PAYOUTS_DETECTION_SCHEMA`) | ISIN, Units, Date, Issuer, Amount, Frequency |
| Motilal | `motilal.js` `MOTILAL_COLUMNS` | ISIN, Instrument, Principle, Maturity, Coupon, Frequency, Investment Date, Last, Market Value/Price, Rating, Qty, Avg Price, Investment Amount |
| Generic holdings | `holding-import.js` `HOLDINGS_SCHEMA` | ISIN/Symbol, Security name, Quantity, Buy/Current value, dates, rating, frequency, yield, payout |

## Variant matrix

Every variant keeps the same underlying rows. The four shapes are columns
reordered, one header renamed to an alias, an unknown extra column, and the two
encodings the family actually arrives in. `web/parser-robustness.test.mjs` runs
them and asserts the parsed holdings are deep-equal.

| Family | Reordered | Alias rename | Extra column | Encoding pair |
|---|---|---|---|---|
| Zerodha holdings | yes | `Qty`, `Avg Price` | yes | CSV rows vs XLSX matrix |
| Zerodha tradebook | yes | `Date`, `Type`, `Qty`, `Trade Price` | yes | CSV text vs XLSX matrix, same paise |
| DigiFInn portfolio | yes | `Quantity`, `Invested Amount` | yes | CSV text vs matrix-through-CSV |
| DigiFInn investment | yes | `Coupon Rate`, `YTM` | yes | CSV text vs matrix-through-CSV |
| DigiFInn transactions | yes | `Units`, `Value` | yes | CSV text vs matrix-through-CSV |
| DigiFInn payouts | yes | `Quantity`, `Payout Amount` | yes | CSV only (the portal exports one shape) |
| Motilal | item order shuffled (geometry decides) | `Units` | yes | PDF only |
| Bank statement | yes | `Description`, `Withdrawal` | yes | CSV rows vs matrix rows |
| Generic holdings | yes | `Company`, `Units` | yes | CSV rows vs matrix |

Fragility tests, one per family: the alias rename reads the row, and removing a
required column refuses with the file, the table and the column name. A missing
`Average Price` in a Kite sheet, `Price` in a tradebook, `Qty` in a portfolio,
`Issuer` in an investment report, `Transaction Type` in a transactions report,
`Units` in payouts, quantity-and-amount in Motilal, money columns in a bank
statement, and `Quantity` in a generic holdings sheet all refuse by name.

## Remaining assumptions, and why they are safe

- **CAS geometry.** The CAS reader assigns a number to a column by its right
  edge and takes the rightmost money column as value for bonds and equities.
  That is a real positional assumption, kept because the printed page carries no
  cell grid. It is safe to keep because `casTotals` compares the parsed sum with
  the statement's printed Grand Total and refuses a mismatch, and because the
  import gate records a break rather than silently writing. The dates are
  day-first because a depository statement is Indian; the ambiguity rule is
  documented at `isoNumericDate`/`asOfDate`, not inferred per row.
- **Motilal geometry.** Rows are bands between ISIN anchors and cells are
  assigned to the nearest header column by x. This is the documented fragility
  of a PDF table. It is safe because the parser only proposes cost, purchase
  date and bond terms; the CAS owns quantity and value, so a misread price
  cannot create units. A section with a header but no usable quantity/amount now
  refuses instead of importing a partial portfolio, and a band that maps two
  numbers to one column refuses rather than fusing them into one value.
- **DigiFInn cashflow column groups.** The group start is named (`Yield`), but
  frequency, maturity and the investment row are read at fixed offsets inside
  the group. A column inserted inside a group would shift them. The export is a
  wide sheet with no per-column labels for the investment row, so there is no
  name to read; it is left as a documented assumption rather than guessed at.
- **Bank statement headerless fallback.** The positional read runs only when
  Debit and Credit are labelled but Date and Description are not, which is the
  hand-kept passbook case the comment names. Any labelled file takes the
  name-driven path.
- **Preamble scans.** `scanPreamble` may suggest an account from the first long
  number when no label exists, but the suggestion is `confidence: "low"` and is
  never a write. `auditStatement`'s closing-balance scan is an audit signal, not
  imported data.
