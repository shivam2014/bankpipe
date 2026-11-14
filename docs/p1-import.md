# P1: one inbox, one plan per resolved account

Status: Phase 0 implemented on `feature/import-inbox`. Base `616b515`.
Scope: the import path only.

## Goal

Reduce the import path to four properties:

1. One inbox owns all four writers: CAS, broker holdings report, bank statement,
   workbook re-import.
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

## Phase 1: the money bugs (tests first)

Three defects, no shared fix:

- **W6, two planners disagree.** Same-date CAS, quantity 10 to 12, no cost in
  the file: `planMerge` previews cost 100000 (old cost unchanged), while
  `casReplacePlan` writes 120000 (cost scaled by quantity). Probe against
  `616b515` confirms both. The inbox shows the first and writes the second.
- **W7, re-import is not idempotent.** `accountFieldState` returns identity
  without a value (`web/import-flow.js:551-553`), so an identical broker
  re-import reports `identityChange: alias`, the writer runs
  `replaceHoldings`, and then reports 0 holdings imported. A no-op must not
  write.
- **W8, one ISIN attaches an account.** Broker matching attaches on a single
  overlapping ISIN (`web/index.html:7599`), while CAS refuses below 80 percent
  (`:7642`). There is no reachable "create anyway" button.

Removes: one of the two cost rules, the spurious alias change, the single-ISIN
auto-attach.

Can break: a CAS re-import stops writing when nothing changed; a broker file
with one overlap now asks instead of attaching; cost on a quantity change
becomes the scaled value the writer already uses. Each needs a failing test
before the fix. Do not fold these into Phase 0.

## Phase 2: one plan per resolved account

Resolve first, then group by `account.id`, so a CAS and a broker report for the
same account produce one plan, one preview and one confirmation.

Removes: duplicate bundles, previews and confirmations for the same account
across report families.

Can break: grouping currently runs before matching, so this changes the order,
not just the key. Files that resolve to nothing, ties, and mutual-fund folios
must stay separate plans; a folio is not a demat. A broker file that could
match two accounts must remain a choice.

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
candidates in import-named files.

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

The first eight rows are counted from the tree. The last five are the map's
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

