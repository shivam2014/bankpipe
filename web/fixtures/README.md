# Test fixtures

`banks/` contains statement fixtures used by `parse.test.mjs`. Structured
fields (account numbers, names, addresses, PINs and ID numbers) are placeholders
or synthetic values. Transaction narrations have had account numbers, FD
numbers, PANs, phone numbers, net-banking logins and third-party personal names
replaced. Amounts, dates and layouts are unchanged so the arithmetic and
date-format cases stay realistic. The demo family (Arjun, Kavita and Rohan) is
fictional and is kept as demo data.

`hdfc.xlsx` is the small browser import fixture used to verify CSV/XLSX parsing;
its account number is synthetic.

`demo-hdfc-oct-2026.csv` is a synthetic demo statement.

Never add an unredacted statement. `check-no-data.sh` scans tracked text and
XLSX fixtures for PANs, mobile numbers and long account/FD-like digit runs; run
it before publishing. The reserved synthetic namespace is a `9999` prefix.
