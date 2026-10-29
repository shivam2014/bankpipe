# BankPipe — Demat integration spec

**Status:** proposal, not implemented. Synthesised from the BankPipe architecture thread and the India portfolio-integration research.
**Tracker:** [`docs/UI-REVIEW.md`](docs/UI-REVIEW.md) carries the live list. **App status:** bank CSV/XLSX import and broker holdings import are live; Demat CAS is not built.
**Hard constraints:** browser-only app · no Python runtime · local-first · no cloud parser · encrypted at rest · fail closed · one number, one owner · dad is a reviewer, not an operator.

---

## 1. The decision in one line

**CAS-first, browser-parsed, monthly.** The CAS statement is the demat equivalent of a bank statement. Broker APIs are a later live-view convenience, not the backbone.

```
CAS PDF (CDSL/NSDL) ──► Web Worker: PDF.js + holdings parser ──► receipt ──► positions
Broker holdings CSV ──► existing column mapper ─────────────────► receipt ──► positions
Manual register ──────► existing sheets ────────────────────────► positions
```

No network call in the import path. No third-party parser. No broker secret in the browser.

---

## 2. What the BankPipe thread changes

The generic research said “self-host `casparser`”. That is correct for a Python/local-service build and **wrong for BankPipe**:

| BankPipe constraint | Consequence |
|---|---|
| Pure HTML/CSS/JS, no Python at runtime | `casparser` (Python + pypdfium2) cannot ship |
| sql.js + IndexedDB, one blob | No server-side parse; PDF parsing must happen in a Web Worker |
| No cloud, no third-party parsing services | Hosted CAS APIs and AA are out |
| Encryption at rest is live (AES-256-GCM, PBKDF2 600k) | The CAS reader is still not built; do not import real CAS data yet |
| One number, one owner | CAS owns demat **quantity**; register owns **cost**; price feed owns **price** |
| Import is a receipt, not an editor | CAS import produces counts, totals and exceptions — never a grid |
| Fail closed | Unknown layout = nothing written + shape report |
| Demo mode | Synthetic CAS fixture must show the full flow before real data |
| Cross-platform | Browser parser works on Mac, Windows, Android, ChromeOS |

The app is also **not a trading app** (ARCHITECTURE.md §9.2). It does not need order placement, live quotes, or broker OAuth to be useful. Monthly quantities plus public price feeds are enough.

---

## 3. Recommended v1 architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ Import → Demat (CAS)                                             │
│                                                                  │
│  drop CAS PDF ──► PAN prompt (memory only)                       │
│                       │                                          │
│                       ▼                                          │
│  Web Worker: pdfjs-dist decrypt → text items → row/column model  │
│                       │                                          │
│                       ├─ layout fingerprint known? ──no──► reject │
│                       ├─ totals reconcile? ──────────no──► reject │
│                       ▼                                          │
│  receipt: accounts · holdings · total · as-of · exceptions       │
│                       │ confirm                                  │
│                       ▼                                          │
│  statement + position snapshots + instrument master + issues     │
│                       │                                          │
│                       ▼                                          │
│  Home / Accounts / Holdings / Review / coverage grid             │
└──────────────────────────────────────────────────────────────────┘
```

**What v1 parses:** holdings only — equities, ETFs, corporate bonds, G-Secs, SGBs, demat/SoA mutual funds, AIFs, NPS. Not full equity transaction history. Not tax lots.

**What v1 does not parse:** insurance policies (leave to the insurance register), property, bank accounts (already covered), capital gains (later via AIS/Console tax P&L).

---

## 4. Why not the alternatives

| Option | Why it fails for BankPipe |
|---|---|
| `casparser` Python library | Python runtime, pypdfium2, pydantic — cannot run in the browser |
| Pyodide + `casparser` | 10–20 MB download, pypdfium2 WASM is not a supported path, slow on phones |
| Hosted CASParser / any SaaS | Sends PAN + full portfolio to a third party; violates the no-cloud rule |
| Account Aggregator | FIU must be regulated; no bonds/G-Secs; consent flow is cloud-based |
| Broker OAuth in the browser | API secret and tokens would live in client JS; Kite/Motilal/Upstox do not allow browser CORS |
| Console/CDSL scraping | Against terms; captcha/OTP automation; fragile |
| Manual holdings CSV only | Safe, but does not cover bonds/MF/NPS across brokers; no automation |

**Fallback if the browser parser proves too fragile:** a small **local companion** (Go or Rust, single binary, no Python) that parses the CAS and exposes `127.0.0.1` JSON. This is the only acceptable “server” because it never leaves the machine. It is a later option, not v1.

---

## 5. Parser contract

Input: original CAS PDF + PAN (memory only).
Output: a JSON object, never raw text.

```json
{
  "meta": {
    "cas_type": "CDSL | NSDL",
    "period_from": "2026-03-01",
    "period_to": "2026-03-31",
    "as_of": "2026-03-31",
    "parser_version": "cas-1",
    "layout_fingerprint": "cdsl-2026-03"
  },
  "investor": { "name": "...", "pan_masked": "XXXXX1234F" },
  "accounts": [
    {
      "depository": "CDSL",
      "dp_name": "Zerodha Broking Ltd",
      "dp_id": "...",
      "client_id": "...",
      "owners": ["..."],
      "joint_holders": ["..."]
    }
  ],
  "holdings": [
    {
      "account_ref": 0,
      "class": "equity | etf | bond | gsec | sgb | mf | aif | nps",
      "isin": "INE...",
      "name": "...",
      "quantity": "50",
      "unit": "share | unit | bond | gram",
      "price_paise": 61250,
      "value_paise": 3062500,
      "face_value_paise": null,
      "coupon_bp": null,
      "maturity": null,
      "folio": null,
      "scheme": null,
      "nav_paise": null
    }
  ],
  "warnings": [
    { "code": "unknown_section", "count": 1, "shape": "A{8}" }
  ]
}
```

**Rules**
- Money is integer paise; quantity is a decimal string, never a float.
- ISIN is the join key. If a holding has no ISIN, quarantine it; do not match by name alone.
- Sum of holding values must equal the section/account total. If not, reject the file.
- Unknown section or column arrangement → reject the whole file, write nothing.
- Re-printed PDFs (“Save as PDF”, browser print, flattened watermark) → reject with “download the original from CDSL/NSDL”.
- Wrong password → explicit error; max 5 attempts; no logging of the PAN.
- v1 supports **one depository format** (CDSL or NSDL, whichever dad’s default is). The second is a follow-up.

---

## 6. Data model mapping

BankPipe is migrating to eight nouns. Demat extends that model; it does **not** add a parallel one.

| Noun | Demat use |
|---|---|
| `person` | Holder / joint holder from CAS |
| `institution` | Zerodha/DP, CDSL/NSDL, AMC, CRA |
| `account` | Demat account: institution, depository, DP ID, client ID, owners, type=`demat` |
| `instrument` | ISIN-keyed equity/bond/G-Sec/SGB/MF/AIF; coupon, maturity, face value |
| `position` | Quantity, cost, price, value, as-of, source, statement_id |
| `transaction` | Bank facts only in v1; demat transactions later |
| `secret` | Unchanged; demat login lives in the vault, never in the import |
| `change` | Every import and correction |
| `statement` | CAS period, as-of, source hash, parser version, status, report |

**Suggested constraints**
- `position` unique on `(account_id, instrument_id, as_of, source)`.
- `statement` unique on `(kind, source_hash)`; secondary identity `(cas_type, period_to, account_count, total_value)`.
- `account` gets `institution_id`, `depository`, `dp_id`, `client_id`, `joint_holders`.
- `instrument` unique on `isin` where present.

**Ownership rules**

| Field | Owner | Behaviour on import |
|---|---|---|
| Demat quantity | CAS | CAS wins; a manual register row becomes a claim and a conflict if different |
| Average cost | Register / broker export | Keep manual cost if present; otherwise null → “cost basis missing” |
| Price | CAS as-of, later price feed | CAS price is a dated fact; a feed price is newer and labelled |
| Value | Computed | `quantity × price`; never typed |
| Net worth | Computed | Never stored as truth |
| Cost basis for XIRR | Register / broker | If null, exclude the holding and say so |

**Conflict behaviour**
- CAS quantity ≠ manual register quantity → `issue` with three actions: use CAS, keep register, or “these are different accounts”.
- CAS quantity ≠ broker CSV quantity → `issue`; show both sources and dates.
- CAS total ≠ sum of holdings → reject the file; nothing is written.
- CAS re-import with same period but different total → `statement_changed` issue; never auto-delete positions.
- Corporate action suspected (quantity changed, cost unchanged) → flag; do not silently adjust cost.

---

## 7. Import UX — a receipt, not an editor

The existing Import screen gains a third card: **Demat (CAS)**.

**Happy path**
```
Demat · CAS
CDSL · Mar 2026 · 2 accounts · 47 holdings · ₹42,18,500
44 matched · 3 need mapping · 12 cost bases missing
[ Import ]  [ Review 3 ]  [ Cancel ]
```

After confirm:
```
Imported CDSL CAS · Mar 2026
2 accounts created/updated · 44 positions written · 3 quarantined
Home updated. Review has 3 items.
```

**Re-import**
```
This CAS is already imported (same period and total). No changes.
```

**Newer CAS**
```
CDSL · Apr 2026
5 quantity changes · 1 new holding · 2 sold out
[ Review changes ]  [ Import ]
```

**Unknown layout**
```
We couldn't read this CAS. Nothing was saved.
[ Download shape report ]   ← no values, no ISINs, no account numbers
```

**Coverage grid**
- Add one row per demat account to the existing Imports coverage grid.
- Green = CAS reconciled; amber = open issues; grey = no CAS for the period.
- CAS is monthly only when there was a transaction; otherwise half-yearly. The grid must say “no statement expected” rather than “missing” when appropriate.

**Review**
- **Quarantine:** unmatched ISIN, unreadable row, unknown section.
- **Decision:** CAS vs register quantity, CAS vs broker quantity, statement changed.
- **Housekeeping:** CAS older than 45 days, cost basis missing, maturity within 90 days.

**Demo**
- Synthetic CAS fixture with fake ISINs and holdings.
- Shows the receipt, the positions landing in Holdings, and the coverage grid.
- No real data, no network.

---

## 8. Security gates

**Gate 1 — encryption before real CAS.** The web build currently persists a plain sql.js blob to IndexedDB. CAS adds PAN + every holding. Do not import a real CAS until the WebCrypto at-rest encryption path is in place and the database cannot be opened without the passphrase.

**Gate 2 — PAN never persists.**
- Prompt for PAN, pass it to `pdfjs-dist` as the password, then drop the reference.
- Never store it in IndexedDB, localStorage, logs, diagnostics, or the DOM.
- Mask it in the UI: `XXXXX1234F`.

**Gate 3 — raw PDF default off.**
- Store SHA-256 + parsed JSON + statement metadata.
- Do not keep the PDF by default.
- Optional “keep encrypted copy for audit” uses the same master key; off by default.

**Gate 4 — parse locally.**
- `pdfjs-dist` and the parser are vendored; no CDN, no network.
- Parse in a Web Worker; the main thread shows progress and remains responsive on a phone.

**Gate 5 — diagnostics are shape-only.**
- CAS type, page count, section names, row counts, column positions, date formats, error codes, pass/fail totals.
- No amounts, names, ISINs, folios, account numbers, or PAN.
- The user reviews the report before sharing it.

**Gate 6 — no broker tokens in the browser.**
- v1 has no broker OAuth.
- If a local companion is added later, tokens stay in the companion’s OS keychain, never in IndexedDB.

---

## 9. Broker integration, honestly

### 9.1 Per-broker best path

The “best” path depends on whether BankPipe accepts a local companion. Without one, the answer is the same for every broker: **CAS for quantity + a holdings export for cost basis**. With one, the broker APIs below are viable.

| Broker | Best with a local companion | Auth / lifetime | Best browser-only | What the holding feed gives |
|---|---|---|---|---|
| **Zerodha** | **Kite Connect Personal** — `GET /portfolio/holdings` | OAuth; access token expires next morning; free; token can trade | **Console → Portfolio → Holdings → XLSX** + CAS | ISIN, quantity, average cost, LTP, P&L |
| **Motilal Oswal** | **MOFSL OpenAPI** — `POST /rest/report/v3/getdpholding` | Portal login; token expires 06:00 daily; free | Holdings export from MO Investor + CAS | ISIN, quantity, average buy price, collateral |
| **ICICI Direct** | **Breeze API** — holdings | Session token expires daily/midnight; free | ICICI Direct portfolio download + CAS | Quantity, average cost |
| **Upstox** | **Analytics Token** — portfolio GET APIs | Read-only token, 1 year; static IP; free | Holdings export + CAS | Quantity, average cost, LTP |
| **Groww** | Groww Trade API — `get_holdings_for_user` | API key/session; verify current token life | Portfolio export + CAS | Quantity |
| **Angel One** | SmartAPI — holdings | Daily TOTP session; free | Portfolio export + CAS | Quantity |
| **Kotak Neo** | Neo API — holdings | Daily session; free | Portfolio export + CAS | Quantity |
| **Dhan** | DhanHQ — holdings | 24-hour access token | Portfolio export + CAS | Quantity |
| **Fyers** | Fyers API — holdings | Daily token | Portfolio export + CAS | Quantity |
| **HDFC Securities** | No public retail API verified | — | CAS + statement | CAS quantity only |
| **Any other** | — | — | **CAS + export** | CAS quantity only |

**The rule**

1. **CAS is broker-agnostic.** One CDSL or NSDL CAS covers every demat account, both depositories, plus MF, bonds, G-Secs, SGBs, AIFs and NPS. You do not need one connector per broker for quantity.
2. **Use a broker holdings export for cost basis.** CAS usually gives equity quantity and value, not average cost. Zerodha Console, Motilal, ICICI Direct and Upstox all export a holdings snapshot with average cost.
3. **Use a broker API only for live view.** It adds OAuth/token handling, a companion, and a secret to protect. For a monthly family tracker, it buys little.
4. **Never use a broker API from the browser.** The API secret and token would live in client JS; Kite/Motilal/Upstox are not browser-CORS-friendly.

**Recommended sequence for BankPipe**

- **Now:** Zerodha Console holdings XLSX (one-time, then monthly if cost basis changes) + monthly CAS. This covers the confirmed Zerodha demat with no secrets.
- **If Motilal is held:** same pattern — holdings export + CAS. Add MOFSL OpenAPI only if live view is wanted.
- **If ICICI Direct is held:** holdings export + CAS; Breeze API later.
- **If Upstox is held and a static IP is available:** Analytics Token is the best long-lived live connector, but it is optional.
- **Everything else:** CAS + export.

**Why v1 has no broker API**
- Browser JS cannot hold the API secret; Kite’s token exchange needs it.
- Kite/Motilal/Upstox APIs are server-side; CORS blocks browser calls.
- A cloud proxy would violate the no-cloud rule.
- A local companion is possible but adds a runtime, signing, and another thing to trust.

**The app does not need live broker sync.** Monthly CAS gives quantity; daily public feeds give price. Live order/trade data belongs in a trading app, which BankPipe explicitly is not.

---

## 10. Price and valuation layer (after import)

| Class | Source | Refresh | Stale after |
|---|---|---|---|
| Equity / ETF | NSE/BSE bhavcopy | daily EOD | 7 days |
| Mutual fund | AMFI NAV | daily | 7 days |
| G-Sec | FBIL / CCIL / NDS-OM | daily | 7 days |
| Corporate bond | CAS market price; exchange trades where available | monthly / manual | 30 days |
| SGB | gold rate + accrued interest | daily / monthly | 30 days |
| NPS | CAS NAV | monthly | 45 days |

- Every valuation row carries `value · as_of · source · freshness`.
- Missing price → show the CAS value and label it “CAS as of 31 Mar 2026”; never invent a price.
- Bond accrual: use coupon rate, frequency, maturity, face value; label “estimated accrued interest” if the schedule is inferred.
- Do not compute XIRR for positions with no cost basis; show “cost basis missing”.

---

## 11. Phases and effort

| Phase | Scope | Effort | Gate |
|---|---|---|---|
| **0** | Extend the eight-noun model: `institution`, `instrument`, `position`, `statement`, `change`; demat account type | 2–3 days | Model migration decision |
| **1** | Manual demat holdings CSV import + column mapper + reconciliation + coverage row | 2–3 days | None |
| **2** | CAS PDF → Web Worker parser for one depository; fixtures; receipt; quarantine; shape report | 2–3 weeks | Encryption landed |
| **3** | Second depository; MF/CAMS section; cost-basis merge; corporate-action flags | 1–2 weeks | Phase 2 stable |
| **4** | Public price feeds + bond accrual + valuation history | 3–5 days | Phase 1 |
| **5** | Optional local companion for Kite/Motilal/Upstox live view | 1–2 weeks | User accepts a host binary |

**Do not start with Phase 2.** Phase 0 and the encryption work are the blockers. Phase 1 proves the model with a file the user already has.

---

## 12. Open decisions

1. **Which depository is the default?** CDSL or NSDL. The one that sends dad’s CAS is the first parser. The other can wait.
2. **Which broker holds the demat account?** Zerodha, ICICI, Motilal, etc. This determines the manual CSV format and the account metadata.
3. **Is a local companion acceptable later?** If yes, live broker sync is possible without a cloud. If no, v1 stays monthly CAS + public prices.
4. **Where does cost basis come from?** Manual register, broker holdings CSV, or “missing” (excluded from XIRR). Do not guess.
5. **Does the app need demat transactions, or only holdings?** v1 holdings; transactions are a later tax feature.

---

## 13. What I need to start

- The app repo path (`~/bankpipe/web`) and confirmation that the model migration is the current workstream.
- Which depository/broker to target first.
- A sample CAS kept **local**; run the shape report and share only the report.
- Confirmation that real CAS import waits for encryption.
- A decision on manual CSV vs local companion for broker data.

---

## 14. One paragraph for the BankPipe agent

> Demat is not a new app; it is the statement mode for demat accounts. Add `institution`, `instrument`, `position`, `statement` and `change` to the migration, then reuse the existing import contract: validate → preview → commit → change log → recompute. v1 parses CAS holdings in a Web Worker with PDF.js, writes position snapshots, and produces a receipt. CAS owns quantity; the register owns cost; public feeds own price. No broker OAuth, no cloud parser, no AA. Do not import a real CAS until the web build is encrypted at rest.
