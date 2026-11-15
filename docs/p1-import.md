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

### Follow-up: recover a sold-conflict accept (landed)

Accepting a sold-conflict ask used to write the report's live row beside the
disposal. The bond then appeared both sold and held, and the disposal kept
`disposed_cost_paise: null`. The broker-first gate prevents the wrong order for a
broker that funds the cost, but nothing recovered from it: no screen edits
`disposed_cost_paise`, and the ask was the only way in — declining it left the
cost unknown, and accepting it wrote the wrong shape.

The acceptance now prices the disposal instead of adding a row. Three rules, all
in `web/import-flow.js`:

- **Which reading a report gets.** `soldReportVerdict` decides between a
  recovery and a new position. A report that dates its purchase after the sale
  is a new holding and is added, never merged into the disposal. A report that
  names exactly the units the live row and the disposal account for
  (`reported === live + disposed`) is the position that was sold, so its cost is
  the disposal's. Every other quantity is the question it was before, because
  the app cannot tell a re-purchase of a different size from a stale snapshot.
  A depository statement is never a recovery: its snapshot is the custody
  record, so a CAS that still names a sold bond stays a person's decision.
- **Which cost wins.** `soldCostAttribution` applies the report's own unit price
  to the disposed units, and only over units the report names. An empty basis is
  filled; a recorded basis is kept and the difference is named on the card, with
  both numbers. Nothing is averaged, and a report that names fewer units than
  the sale prices nothing.
- **One report, one total.** When the report names exactly the position on file,
  the rest of its cost belongs to the live units and fills only an empty live
  cost. The same money never lands on both rows, and a known live cost is never
  overwritten by the report. A bond held in several lots is left alone with a
  warning: this writer decides per ISIN, so pricing one lot would repeat or
  collapse the cost.

`mergeRowsFromPlan` applies an accepted recovery to the stored disposal row,
matched by its `txn_key` (or its date on a legacy row), and leaves every other
field of that row alone. The plan counts a priced disposal as `soldCost`, not as
an updated holding, so the card says "Record the sold cost basis" and the net
count does not claim a holding appeared.

A linked cost portfolio is untouched: `planLinkedSales` still consumes its FIFO
lots once, at CAS time, and the recovery only ever writes the demat's disposal.
When the portfolio already priced the sale, the broker's different number is
kept-and-flagged, which is the same rule.

Measured on synthetic rows with the probe in `scripts/probe-import-plans.mjs`,
statement first and broker second, then the ask accepted:

| | Before `71293c5` | After |
| --- | ---: | ---: |
| rows written | 2 | 1 |
| live rows for the sold bond | 1 | 0 |
| `disposed_cost_paise` | null | 200000 |
| `net.added` | 1 | 0 |
| `net.soldCost` | — | 1 |

The second import says "already matches" in both cases. What changed is the row
it matched: before, the report's own row, held beside the sale; after, the
priced disposal.

The card gate stays. It is still the cheap path: a broker that funds the cost is
imported first, and the statement's disposal takes the cost at CAS time. What
changed is that the expensive path is now recoverable.

### Landed: the account a statement moves

A consolidated statement can list a demat in its holdings table and name the same
demat on its movements. The card used to offer `New demat account` for the first
fact and disable Import because that account was not on file for the second. The
rule is now one decision, `movementAccountGap` in `web/import-flow.js`, and the
card's account line, pill, footer and primary button all read it:

- **The statement may create the account it moves, when it lists holdings for
  that account.** Its rows are the account's identity and its first holdings, and
  the writer creates accounts before it writes events, so the disposal lands in
  the same import.
- **A movement account the statement never lists in its holdings stays blocked.**
  There are no rows to build an account from. The card labels the pill `Add the
  account first`, keeps the footer sentence `No demat on file for the movement
  account …8054. Add that account, then import again.`, and opens the add-account
  form with the BO ID filled in.
- **A movement that would land in another account stays blocked.** An account
  attached by ISIN overlap whose number is a different BO ID is not this
  movement's home.
- **An undecided choice is not a gap.** Two matching accounts still ask on the
  card, and the movement lands wherever the person chooses.
- **A fund movement with no account belongs to its folio.** A CAS prints a SIP
  with no BO ID because the folio owns it. An account-less movement that names a
  fund ISIN, or whose ISIN is a folio row in the statement, is a folio movement,
  not a demat gap; the folio's own plan applies it.
- **Any other account-less movement needs an account on file.** An equity or bond
  disposal with no account and no resolved demat keeps the old refusal and its
  exact sentence. Nothing the import creates can be chosen for it.

The writer was already able to do this; only the card refused. The two are now
checked together: `scripts/render-import-demat.mjs` presses Import on the created
card and reads the store back, and the same script renders the blocked card so the
pair cannot drift. `scripts/render-import-folio.mjs` is the fund-movement shape:
it renders the card Ready with the SIP beside the folio's movements, then presses
Import and checks that two demats and the folio were created, the fund stayed at
the statement's units and no demat claimed the fund row.

Seventeen per-ISIN credit refusals (**`ISIN: a credit with no purchase or
transfer-in wording is not added (PAYOUT-CR CM …)`**) used to run as one wall that
pushed `Add 31 holdings`, `Record 4 sales` and `Move 2 matured to history` below
the fold. `importWarningDigest` folds that one class into
`17 credits were not added because they name no purchase or transfer-in.` with
the refusals behind a disclosure. Every other warning keeps its own line, and the
refusal itself is unchanged.

The disclosure names each security once, with the count when it repeats:
`INE000000405 · 3 credits · PAYOUT-CR CM M51766 TM/CP SETT`. The reason is the
count line's to state, so a detail line carries only the ISIN and the statement's
own printed wording. One security printed two ways keeps two lines, so no line
stands for a refusal it does not describe. `scripts/render-import-demat.mjs`
opens the disclosure in its shot and fails if a detail line repeats the reason or
names a security twice.

Counts: tests 1230 → 1238, screens 1 → 2, stored fields 0 → 0, refusals removed 1.

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

## What each account is missing

The securities-accounts card names, per account, the gaps a report or an edit
can fill, and carries one closed `Which report?` disclosure for the card.

Computed in `web/import-flow.js` (`importAccountGaps`) from provenance the
ledger already stores: `holdings_source`, `holdings_as_of`, `cost_source`,
`cost_as_of`, and each row's `cost_paise`, `yield_bps`, label and `as_of`. No
new stored field, no score, no dismissal flag.

| Line | When it appears | What clears it |
| --- | --- | --- |
| `No cost on N holdings` | an active row with no cost | a broker holdings report, or an edit |
| `Cost from <date>, older than the <date> holdings` | `cost_as_of` behind the snapshot date | a newer broker holdings report |
| `No coupon or maturity on N bonds` | a bond with no coupon in the field or the label, and no maturity anywhere | a broker report, or an edit |

A typed account has no source on its meta and none on its rows. Its lines read
`Could add cost for N holdings` and `Could add coupon and maturity for N bonds`,
muted rather than amber, and never name a report. Matured and disposed rows are
history, not gaps; an account with nothing missing renders no line at all.

Two absences are deliberately not lines:

- **A month with no new statement.** A long-held bond's quantities do not
  change, so a calendar rule would nag every month for a file that says nothing
  new. The meta line already dates the snapshot (`CAS 31 Oct 2026`), and
  `Newer broker data` already flags the one case where a stored cost is newer
  than the statement.
- **A row whose `source` is empty.** `cas-apply.js:831` writes every CAS row
  that way; the account-level `holdings_source` is the same fact, so flagging
  the row would call every healthy CAS account unsourced. `Broker-only` already
  says when no depository statement has named the account.

`Broker-only` now reads the stored `holdings_source` rather than the row-date
fallback in `accountFieldState`, so an account typed by hand is not labelled
broker-only. The disclosure renders only when a file can fill something, and its
last line is the claim that holds: "Nothing updates on its own: month-end
quantities, daily prices and terms where a source exists, on your schedule."

Counts, before → after: screens 1 → 1, stored fields 0 → 0, user decisions
0 → 0 (a disclosure is not a decision), disclosures on the import screen 3 → 4,
lines per account on the card 2 → 3 at most, tests 1152 → 1163.


