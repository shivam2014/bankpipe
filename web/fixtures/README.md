# Test fixtures

`banks/` contains statement fixtures used by `parse.test.mjs`. Structured
fields (account numbers, names, addresses, PINs and ID numbers) are placeholders
or synthetic values. Transaction narrations use `TEST PAYMENT N` labels.
Amounts, dates and layouts are unchanged so the arithmetic and date-format cases
stay realistic.

`hdfc.xlsx` is the small browser import fixture used to verify CSV/XLSX parsing;
its account number is synthetic.

`demo-hdfc-oct-2026.csv` is a synthetic demo statement.

`motilal/` holds a 12-page Motilal Portfolio Holding Summary rebuilt from the
export's printed geometry. `scripts/motilal-fixture.mjs` draws the span table in
`scripts/motilal-fixture-spans.json` at each item's page, x, y and font size on
blank pages with the standard Helvetica font. Every byte and object is written
by the generator; no original PDF byte, font or object survives. Holder, UCID,
advisor, ISINs, contact addresses and every money cell are substituted. Dates,
coupons, quantities and instrument names keep the export's printed values, so
the column geometry is the export's without any of its bytes.

`motilal-fixture.test.mjs` proves the committed PDF is byte-identical to the
generator's output, reads the same 17 rows as the expectation beside it, and
extracts exactly the substituted span table. Regenerate with:

    node scripts/motilal-fixture.mjs

Never add an unredacted statement. See `PRIVACY.md` for the fixture rule and the
local denylist generator. The reserved synthetic namespace is a `9999` prefix.
