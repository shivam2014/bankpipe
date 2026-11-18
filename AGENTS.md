<!-- ratchet:begin -->
## Ratchet workflow (managed)

Every non-trivial task starts with a contract and ends with evidence.

1. `ratchet task start --role coder --goal "<goal>" --scope "<glob>" --verify "<command>"`
2. Work inside the scope. With no live contract, mutations are denied; reads and read-only commands still work.
3. `ratchet check` runs the contract's verify commands and records the exit codes.
4. `ratchet done` refuses without passing evidence, and refuses changed paths outside scope.

One contract belongs to one checkout. Parallel threads get separate worktrees; do not share an index or a hook.

- New tests, or a check file that legitimately changed: `ratchet amend --reason "..."`.
- Giving up, or a stranded run: `ratchet abandon --reason "..."` or `ratchet abandon --run <id> --reason "..."`.
- A human-approved operational rule (force-push, hard-reset, git-clean): `ratchet approve --rule <id> --reason "..."`.
- `task start --force` replaces a live contract and records the old one as abandoned; never use it to get past a denial.
- A task touching more than 12 real files: start with `--max-files 40`.

Do not edit `.ratchet/`, bypass a hook with `--no-verify`, or widen scope silently. Put throwaway probes in the OS temp directory (`/tmp` on POSIX, `%TEMP%` on Windows), not in the repo.
<!-- ratchet:end -->

## Privacy

Never commit real statements, databases, denylists or identifiers. Fixtures are synthetic only. Real files are read through `BANKPIPE_PRIVATE_IMPORT_DIR` and never copied into the repo. After adding new statements, regenerate the local denylist:

    BANKPIPE_PRIVATE_IMPORT_DIR="$HOME/statements" node web/tools/privacy-denylist.mjs

The repository stays private until the history scrub in [`docs/PUBLIC-REPO.md`](docs/PUBLIC-REPO.md) is complete. `.github/workflows/privacy.yml` fails when tracked content contains a PAN, Aadhaar, account/demat, IFSC, email or phone shape. A synthetic fixture can be cleared only through `scripts/privacy-allowlist.json`; prefer the reserved `9999` namespace, never add a real identifier, and never wildcard a directory. `node scripts/check-history-privacy.mjs` is the post-rewrite gate over every blob on every ref.

## Product rules

Two settled decisions live in [`docs/PRODUCT.md`](docs/PRODUCT.md) and apply before any change to valuation or account identity. A maturity date is not a payment: a matured bond stays in net worth, flagged `awaiting payment`, until a matched bank credit marks it received. India is the constraint, not the model: accounts are containers, a report is optional enrichment, manual entry is first-class, and identity is the account plus its source's stable key rather than a BO ID.

Read the page before changing either. If another document or an issue-log row disagrees, the page wins and the row gets a pointer.

## UI work

A change to a screen in `web/` starts from [`.opencode/skills/bankpipe-ui/SKILL.md`](.opencode/skills/bankpipe-ui/SKILL.md).

- Rank before markup: one job, one primary action, at most six visible facts per card.
- Run `node scripts/check-ui-tokens.mjs` before `cd web && node --test`.
- A UI pull request carries before/after screenshots at 390 and 1280, light and dark, and the rubric score.
