# P1: one inbox, one plan per resolved account

Status: Phases 0-2 implemented on `feature/import-inbox`. Base `616b515`.
Scope: the import path only.

## Goal

Reduce the import path to four properties:

1. One inbox owns the entry point and dispatch for all four writers: CAS,
   broker holdings report, bank statement, workbook re-import. "Owns" does not
   mean one plan schema: a bank statement is a ledger plan, and the workbook is
   a whole-database restore.
2. One plan per resolved account.
3. One confirmation per plan.
4. A file whose account is unresolved stays its own plan, and says so.

No new screen, parser, stored field, credential or visual language. The class
allocation split (bank/FD, mutual funds, bonds, equities, insurance, gold) is
fixed.

## The frame this rejects, and why

Do not write "one preview per demat chain". A chain is not computable here.

- Bundles are grouped before account matching, by report family:
  `` `${family}:${accountKey}` `` in `web/import-flow.js:381`. A CAS and a
  Motilal report for the same demat therefore become two bundles, with two
  previews and two confirmations.
- There is no BO-ID to broker-key map anywhere. `sameAccount` returns
  `unknown` when either side is a broker client code (`web/bo-id.js:50-56`).
  Building a literal demat chain needs a new stored mapping, which P1 forbids.

One plan per **resolved account** is computable after matching: a CAS demat and
a broker file can both resolve to the same `account.id`. That is the unit P1
can use. A demat chain is not.

Two facts make it hard:

1. Grouping happens before resolution, so the resolved account is not known
   when the bundle key is chosen.
2. The identifiers do not join: BO ID, UCID, client ID and folio are matched by
   different rules, and a client code is deliberately not evidence about a BO
   ID.

## Boundary: line ranges, not files

P1's boundary is a set of ranges inside `web/index.html`, not a set of files.
The four writers already share `web/import-flow.js`, `web/cas-apply.js` and
`web/db.js`. Splitting the file would move code without changing behaviour.

Ranges below are as of `616b515`; they shift as phases land.

| Phase | Owned region in `web/index.html` | Shared modules read, not edited |
| --- | --- | --- |
| 0 | `2852-3372`, `1072-1083`, `12517-12530`, `3513`, `13040`, `4054`, `7427`, `8132-8141`, `8455-8462`, `8624-8625`, `8911` | `demat-card.js`, `bond-sync-*.js` (deleted) |
| 1 | `7554-7650` (plan and resolve), `8693-8731` (broker apply) | `import-flow.js`, `cas-apply.js` |
| 2 | `7427-7615`, `7810-7860` (bundle and resolve) | `import-flow.js` |
| 3 | `7869-8129`, `8889-8965`, `10728-10960` (gates and writes) | `db.js` |

`web/cas.js`, `web/cas-apply.js` and `web/db.js` are owned by the CAS parser
writer. P1 does not edit them; a phase that needs a change there hands it off.

## Phase 0: remove what is provably unreachable

This change. No live import path changes.

Removes:

- The DigiFInn bond-sync card cluster: `bpDigiFinnReport`,
  `bpDigiFinnRenderStatus`, `digiFinnTargetDemat`, `bpDigiFinnKeepPortfolio`,
  `bpDigiFinnReview`, `bpDigiFinnExistingPrompt`, `bpDigiFinnNewPrompt`,
  `bpDigiFinnChoose`, `bondSyncPreviewBodyHtml`, `bpDigiFinnSyncPreview`,
  `bpDigiFinnCancel`, `bpBondSyncAsk`, `bpDigiFinnSyncApply`,
  `digiFinnCardHtml`, plus `bpOpenBondImport` and `bpOpenDigiFinn`, which only
  looked for the card this cluster rendered.
- Its support modules `web/bond-sync-dialog.js` and
  `web/bond-sync-warnings.js`, the dialog markup and the `df-*` / `sync-*` CSS.
- The unused exports of `web/demat-card.js`; only `dematText` is used by the
  live CAS path.
- `window.bpImportCreate`, `bpImportInboxEntryDescriptor`,
  `window.bpImportWorkbook`, the `state.creates` map it wrote, and `state.last`
  (written once, never read).
- The writes to `meta.snapshot_source` and `meta.snapshot_as_of`; nothing reads
  either field.
- Dead imports: `digifinn.js` entirely from `index.html`, `parseReportFile`,
  `buildBondSync`, `scoreBondPortfolio`, and the unused `demat-card.js` names.

What can break: nothing reachable. Every handler above has zero references
outside the cluster, and the two support modules are imported only by it. If a
caller turns up, stop and keep the code.

What this does **not** move: importers, live entry controls, live preview
builders, write buttons, confirmation gates and planners stay flat. The deleted
code was already unreachable, so it was never in those live counts. Phase 0
moves lines, tests and shape-only tests down; Phases 1-3 move the live counts.

## Phase 1: the money bugs (landed at `34cf97a`)

Three defects, three commits, one failing test each:

- **W6, two planners disagreed.** Same-date CAS, quantity 10 to 12, no cost in
  the file: `planMerge` previewed cost 100000 while `casReplacePlan` wrote
  120000. **Settled rule: cost is evidence, not arithmetic.** The writer keeps
  the stored cost whole when a quantity moves without a cost in the statement,
  and the preview says the last known cost is kept. It states otherwise only
  when the statement names a debit; then cost is allocated to the units that
  left, which the sale and FIFO path needs. A blanket removal of scaling was
  rejected for that reason.
- **W7, re-import was not idempotent.** `accountFieldState` now reads the key
  already stored in `meta.ucid`, `meta.client_id` or `meta.demat` and compares
  it case-insensitively with the incoming one. Equal key plus equal date yields
  no change and no write; a genuinely different key still reports an alias.
- **W8, one ISIN attached an account.** Both resolvers now use one `attachId`:
  a real identity, or 80 percent ISIN overlap. Below that the file is a listed
  candidate with no target, and creation is offered only when nothing matches.

Removed: the second cost rule, the spurious alias change, the single-ISIN
auto-attach.

Residual, and it cannot be closed without the stored mapping this phase
forbids: a broker file that matches nothing still creates a broker-only
account, and a later CAS can create a second demat for the same holding because
no BO ID to broker-key map exists. That is Phase 2/3 identity work.

## Phase 2: one plan per resolved account

Resolve first, then group by `account.id`, so a CAS and a broker report for the
same account produce one plan, one preview and one confirmation.

Removes: duplicate bundles, previews and confirmations for the same account
across report families.

Can break: grouping currently runs before matching, so this changes the order,
not just the key. Files that resolve to nothing, ties, and mutual-fund folios
must stay separate plans; a folio is not a demat. A broker file that could
match two accounts must remain a choice.

### Landed: resolve, then group (`3adecc2`)

`groupResolvedPlans` groups after resolution, by the account each file landed
on. A CAS target and a broker file that resolve to the same `account.id` become
one plan with one preview and one confirmation; the broker's receipt is planned
against the rows the CAS leaves, so its cost fills the statement's rows instead
of adding them a second time. An unresolved file, a tie and a folio keep their
own plan. A CAS still writes every target in its statement, and each broker
still writes its own rows in the same order, so the stored rows are what the
separate cards stored.

The probe (`scripts/probe-import-plans.mjs`) counts a CAS, a Motilal report and
a Zerodha holdings file for one demat:

| Metric | Before | After |
| --- | ---: | ---: |
| family bundles | 3 | 3 |
| plans | 3 | 1 |
| previews | 3 | 1 |
| confirmations | 3 | 1 |
| `replaceHoldings` calls | 3 | 3 |
| rows written | 8 | 8 |

The merged rows are field-for-field equal to the separate rows, and a second
confirmation of the same set changes no field and runs no writer.

A statement that records movements is the one exception. Folding a broker into
that plan would write the statement first, so the broker's cost would arrive
after the disposal and the realised cost would be lost. The statement and the
broker stay separate cards, and the statement's card says to import the broker
first. The same exception keeps an ask about a bond the statement sold on the
broker's own card, where it is visible, instead of behind one plan-wide accept.

When a staged broker would actually put a cost on a disposed ISIN, the
statement's primary is disabled and its card says "Import the Motilal report
first", with a button that goes to that card. The gate is narrow. A broker with
nothing to write, another account, another ISIN or a date it cannot pass leaves
the statement ready, so the statement is never trapped behind a card that cannot
be applied. `Import all` closes through the same ready flag.

The card's added and updated counts are the plan's net rows, not the sum of its
files. A row one file adds and another fills cost on is one added holding, not
an add plus an update. The per-file lines say what each file does, not how many
additions it contributes. Every ask is on the card, so the plan-wide accept
cannot cover an ask the person did not see, and the account line counts every
account the plan will write, including a folio it creates.

A file that resolved to nothing still creates its own account beside an
existing demat that only a later CAS can relabel. Grouping leaves that
unchanged: there is no account id to join on, and inventing one is the stored
mapping this phase forbids.

### Follow-up: recover a sold-conflict accept

Accepting a sold-conflict ask currently writes the report's live row beside the
disposal. The durable fix is to keep the `disposed_at` row and fill
`disposed_cost_paise` from the report's cost, so the wrong order is recoverable.
It is not in Phase 2. It changes what an accepted ask writes, and it needs tests
for a full sale, a partial sale, a re-purchase and a linked cost portfolio. The
card gate prevents the wrong order in the meantime.

## Phase 3: one gate and one write per plan

The map counts 14 confirmation gates, 12 write buttons and 4 write primitives
on the live path. Each family handler currently asks and writes on its own.

Removes: per-screen gates and direct store writes inside family handlers; the
plan becomes the only thing a gate approves and a writer executes.

Can break: the bank statement is not a holdings snapshot and should stay on its
own path; a CAS fans out to several accounts, so one plan may still write more
than one account. This phase needs `web/db.js`, so it is a handoff.

## Phase 4: replace source-text tests

The map counts 33 import tests that assert source text or CSS selectors,
including all 21 in `web/cas-import-ui.test.mjs`. A coarse scan finds 36
candidates in import-named files at `616b515`.

Removes: grep-based assertions that fail on a rename.

Can break: some protect real invariants cheaply (Cancel before Accept, no store
call before consent, one card not two). Those need a DOM or behaviour test, not
deletion. Not every shape test can be replaced one-for-one; a rename-only test
is safe to drop, an ordering or consent test is not. Do this with the phase
that touches the screen, not as a sweep.

## Out of scope

- Mobile type and touch targets (14px inputs, 34px help control, 760px bank
  table). Real, but a visual change, so it needs its own contract.
- Any new stored field, including a BO-ID to broker-key map.
- Re-planning the class allocation split.
- A new parser.

## Counts at `616b515` and after Phase 0

| Metric | Before | After | Delta |
| --- | ---: | ---: | ---: |
| `web/index.html` lines | 15362 | 14751 | -611 |
| import tests | 371 | 334 | -37 |
| total tests | 1078 | 1040 | -38 |
| source-text / selector tests (coarse scan) | 36 | 29 | -7 |
| `type="file"` controls | 14 | 13 | -1 |
| `<dialog>` gates | 3 | 2 | -1 |
| native `confirm()` calls | 23 | 22 | -1 |
| reachable importers | 10 | 10 | 0 |
| reachable preview builders | 9 | 9 | 0 |
| reachable write buttons | 12 | 12 | 0 |
| reachable confirmation gates | 14 | 14 | 0 |
| planners | 4 | 4 | 0 |

The first seven rows are counted from the tree. The last five are the map's
live counts, checked for changed references rather than re-derived: the deleted
symbols do not appear in them.

The live-path rows are flat by design: the deleted code was unreachable, so it
was never in those counts. Phase 0 moves lines and tests down; Phases 1-3 move
the live counts.

The map said the cluster had 23 unreachable tests. It is 39: 20 in
`demat-card.test.mjs`, 12 in `bond-sync-warnings.test.mjs`, 7 in
`bond-sync-dialog.test.mjs`, plus one source test in `portfolio-match.test.mjs`.
Two `dematText` tests were kept for the live CAS path, so 38 net tests left the
suite. `buildBondSync` remains in `digifinn-reports.js` with direct tests; it is
a library planner, not a handler, so the planner count does not move until that
library surface is retired.

