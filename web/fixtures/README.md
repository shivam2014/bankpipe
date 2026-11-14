# Test fixtures

`banks/` contains statement fixtures used by `parse.test.mjs`. Structured
fields (account numbers, names, addresses, PINs and ID numbers) are placeholders
or synthetic values. Transaction narrations use `TEST PAYMENT N` labels.
Amounts, dates and layouts are unchanged so the arithmetic and date-format cases
stay realistic.

`hdfc.xlsx` is the small browser import fixture used to verify CSV/XLSX parsing;
its account number is synthetic.

`demo-hdfc-oct-2026.csv` is a synthetic demo statement.

Never add an unredacted statement. See `PRIVACY.md` for the fixture rule and the
local denylist generator. The reserved synthetic namespace is a `9999` prefix.
