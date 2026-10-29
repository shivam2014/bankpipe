<p align="center">
  <img src="./assets/readme/hero.svg" width="100%"
       alt="BankPipe — every account, deposit and policy in one local-first family ledger">
</p>

<h1 align="center">BankPipe</h1>

<p align="center">
  <b>A family finance ledger that can prove its own arithmetic.</b><br>
  Import the statement your bank already gave you. Reconcile every rupee. See the whole portfolio.<br>
  Browser-only, encrypted at rest, no BankPipe account, no upload to us.
</p>

<p align="center">
  <code>browser-only</code> · <code>zero npm dependencies</code> · <code>391 tests</code> · <code>MIT</code>
</p>

![BankPipe home dashboard: net worth, allocation donut, six months of cash flow and upcoming maturities](./assets/readme/home.webp)

<p align="center"><sub>The sample dashboard: net worth, allocation, six months of cash flow, the next four maturities and protection cover.</sub></p>

## Why this exists

A spreadsheet tracks money by trusting whoever typed the last cell. That works until a
statement is re-imported twice, a running balance is copied wrong, or two people edit the
same file. Then the number looks fine and is not.

BankPipe starts from the bank's own export and makes the arithmetic the gate:

- **`opening + credits − debits = closing`.** The preview checks the statement header,
  the parsed rows and the running-balance chain before you press Import.
- **A file with no recognisable header is refused before anything is written.** A row
  that does not reconcile is imported with the break recorded in Review, never silently
  accepted.
- **Re-importing is a no-op.** A transaction's identity includes the account, date,
  amount, balance and narration, so overlapping statements add only what is new.
- **Exceptions become a short review list.** A balance break or a possible duplicate
  appears with the expected and actual figures, and you accept or ignore it.

The result is a ledger you can leave alone for six months, hand to a family member, or
re-import a whole year into without creating a second copy of everything.

## See it

<img src="./assets/readme/import.webp" width="100%" alt="Import preview: a matched HDFC statement, 14 transactions, running balance checks out">
<br><sub><b>Import with proof.</b> The file's account number picks the destination. Nothing is written until you press Import, and the balance chain is checked first.</sub>

<img src="./assets/readme/transactions.webp" width="100%" alt="Transaction ledger with account, description, amount and running balance">
<br><sub><b>One ledger, every account.</b> Salary, SIPs, rent, groceries and interest in date order, with the balance after each row.</sub>

<img src="./assets/readme/assets-allocation.webp" width="100%" alt="Assets page with the net-worth allocation donut, bank accounts and holdings by class">
<br><sub><b>The whole balance sheet.</b> Bank accounts, fixed deposits, equity, mutual funds, bonds, gold, PPF and insurance, grouped the way a family thinks about them.</sub>

<img src="./assets/readme/review.webp" width="100%" alt="Review page with two balance exceptions and the evidence for each">
<br><sub><b>Review exceptions, not chores.</b> Each break or duplicate carries the date, amount and the reason it was flagged.</sub>

<table>
  <tr>
    <td width="62%" valign="top">
      <img src="./assets/readme/account.webp" alt="HDFC account page with balance and recent transactions">
      <br><sub><b>Every account has its own page.</b> The latest balance, the transactions behind it and the deposits linked to it.</sub>
    </td>
    <td width="38%" valign="top">
      <img src="./assets/readme/mobile.webp" alt="BankPipe on a phone: account balance and recent transactions">
      <br><sub><b>Small screen, same ledger.</b> The interface reflows to a phone without hiding the numbers.</sub>
    </td>
  </tr>
</table>

## What it tracks

| Asset | What BankPipe keeps | How it gets there |
|---|---|---|
| Bank accounts | balance, statement history, running-balance checks | CSV or XLSX export, including password-protected XLSX |
| Fixed deposits | principal, rate, start, maturity, linked account | workbook import or by hand |
| Equity | quantity, price, current value | broker holdings CSV/XLSX |
| Mutual funds | units, NAV, folio | holdings import or by hand |
| Bonds | ISIN, coupon, maturity, rating, cashflow | DigiFInn reports, ratings CSV, manual lots |
| Gold | grams, purity, price per gram | by hand |
| PPF | balance, start, maturity | by hand |
| Insurance | policy, cover, premium, maturity | workbook import or by hand |

The home page adds it up as **net worth = every account balance + every holding value**.
Liabilities are deliberately outside that figure; the app does not pretend to be an
accounting system.

## Import once, then verify

1. In net banking, open **Accounts → Statement** and download **CSV** or **XLSX** for the
   period you want. Keep the original file.
2. Open **Import → Bank statement** and choose it. The account number in the preamble
   selects the destination; if it does not match, the app shows both numbers and asks.
3. Read the preview: date range, rows ready, rows already held, and whether the running
   balance checks out. Press **Import** only when those are right.
4. Anything that does not reconcile lands in **Review** with the evidence. Health shows
   the state of every account.

Newest-first exports are stored oldest-first, so the latest balance is the closing
balance. A single-date file is ordered by its running balance, not by file order.

## Privacy model

BankPipe is a static page. There is no BankPipe server, no account, no telemetry and no
upload path to the author.

- The ledger is SQLite (sql.js) in the browser, sealed with **AES-256-GCM** before it
  reaches IndexedDB. The key is derived from your passphrase with **PBKDF2-HMAC-SHA256,
  600,000 iterations**.
- Google Drive backup is optional. Manual snapshots are gzip-compressed, encrypted with a
  random data key, then uploaded; the automatic copy is split into fixed 64 KiB blocks and
  only changed blocks are uploaded. The passphrase never leaves the tab. Google sees file
  names, sizes, timestamps and ciphertext.
- Diagnostics are shape-only: column positions, counts and value shapes, never amounts,
  names or account numbers.
- The only network calls are the optional Google Drive backup, an IFSC lookup
  (`ifsc.razorpay.com`) when you add a bank branch, and, on the local server, BSE/SMEST
  lookups for bond prices. All three are visible in the source.

`web/server.mjs` is a local static server plus two price routes. It is not a backend for
your data.

## Run it

```bash
git clone https://github.com/shivam2014/bankpipe.git
cd bankpipe
./launch.sh
```

`launch.sh` serves `web/` on the first free port from 8765 and opens it. On any platform:

```bash
node web/server.mjs
# http://127.0.0.1:8801/
```

There is nothing to install. Node.js is the only requirement, and the vendor folder
already contains the two browser libraries the app uses.

Open **`/?demo=1`** for the sample portfolio in the screenshots. Every name, account
number and amount in it is invented.

## Tests

```bash
cd web && node --test
```

391 tests cover statement parsing, date and amount formats, reconciliation, duplicate
detection, encryption, backup/restore, bond maths, holdings import and the static
server's refusal to serve private files.

Some fixtures began as real export shapes. Account numbers, names, addresses, phone
numbers and ID numbers in them were replaced with made-up values; amounts and layouts
were left alone so the arithmetic and date-format cases stay realistic.

## Project layout

| Path | What it is |
|---|---|
| `web/` | the app: UI, storage, parsers, crypto and their tests |
| `web/server.mjs` | zero-dependency static server and local price routes |
| `web/fixtures/` | statement fixtures used by the tests |
| `docs/` | UI review notes |
| `site/`, `worker/`, `scripts/` | deployment experiments and the optional Drive broker |

## Limits

- **PDF bank statements are not supported yet.** CSV and XLSX are the reliable path; a
  text-layer PDF reader is the next import. Scanned statements need OCR before any
  parser can trust them.
- **Demat CAS is not built.** The bond and equity importers cover the current workflow.
- **The hosted build cannot fetch bond prices.** BSE and SMEST lookups need the local
  server, so those buttons appear only on `127.0.0.1`, `localhost` or `[::1]`.
- **It is a family ledger, not tax or investment advice.** Figures are gross unless a
  screen says otherwise; TDS is not modelled on bond cashflows.
- **One browser, one ledger.** Drive backup moves a sealed copy; it is not multi-user
  sync.

## Contributing

Issues and pull requests are welcome. Run `cd web && node --test` before opening a PR.
If you are changing a parser, add a fixture and a test that fails on the old code first.
Do not commit real statements, account numbers or personal data.

## License

MIT. See [LICENSE](./LICENSE).
