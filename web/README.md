# BankPipe web app

The static browser build: UI, parsers, storage, encryption and their tests. There is no
build step and no server-side runtime.

## Run

From the repository root:

```bash
./launch.sh
```

Or serve this folder directly:

```bash
cd web
node server.mjs
# http://127.0.0.1:8801/
```

Do not use `python3 -m http.server`: it exposes `private/` and dotfiles. The bundled
server refuses `/private`, dotfiles and its own source, validates the Host header, and
sends frame/nosniff headers.

Deep links:

- `?demo=1` — the sample portfolio, with no passphrase and no writes
- `?view=import` — Import
- `?view=transactions` — Transactions
- `?view=assets` — Assets
- `?view=settings` — Settings and backup

## What works today

- **Bank statement CSV/XLSX** import with header detection, duplicate-safe merging,
  balance-chain checks and SQLite persistence. Password-protected XLSX is read on-device.
- **Holdings** CSV/XLSX import for equities.
- **Bonds** from DigiFInn reports, a ratings CSV, or manual lots; BSE prices and SMEST
  details on the local server.
- Dashboard, accounts, assets, upcoming, review and transactions views.
- Encrypted database at rest and optional Google Drive backup.

## What is not built

- **Demat CAS PDF** — no file input yet; the next reader.
- **PDF bank statements** — text-layer PDF is planned. Scanned statements need OCR.

## Tests

```bash
cd web && node --test
```

## Storage

- Transactions shown by the demo: `localStorage` (`bankpipe.txns.v1`).
- Ledger: `sql.js` + IndexedDB (`bankpipe.db.v1`), sealed with the database passphrase
  (AES-256-GCM, PBKDF2-HMAC-SHA256 600,000 iterations) before it reaches IndexedDB.
- Nothing is uploaded. Google Drive backup is opt-in and receives only encrypted data:
  gzip-compressed manual snapshots, and the 64 KiB blocks that make up the automatic copy.

The passphrase is never stored. The only copy of the plaintext database is in memory
while the app is unlocked.
