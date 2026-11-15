# Import fixtures

Every file in this directory is synthetic. Names, account numbers, ISINs and
amounts are invented, and each fixture stays small enough to review in a diff.

Real statements never enter the repository. They carry account numbers, names,
holdings and amounts, and git history makes a leaked file expensive to remove.
The private harness reads them from a directory outside the repo and never
copies them in.

`pdf/locked-synthetic.pdf` is a one-page PDF with no statement in it, locked
with the password `Synthetic1`. It exists to exercise the import password gate.

## Public suite

Run the synthetic tests from the repository root:

    node --test web/import-regression.test.mjs
    node --test web/import-flow.test.mjs
    cd web && node --test

`samples.mjs` holds the corpus. `import-regression.test.mjs` walks it through
detection, parsing, bundle grouping and the XLSX round-trip the page performs.

## Private harness

Point the harness at a directory of real statements:

    BANKPIPE_PRIVATE_IMPORT_DIR="$HOME/statements" node --test web/import-private.test.mjs

The directory is read-only and symlinked files are fine. Without the variable
the test is skipped. A PDF is listed but not parsed here, because the page owns
PDF text extraction. The DigiFInn paid-cashflow export is not recognised; the
future-cashflow export is.

## Render pair

`pdf/cas-sold.pdf` and `pdf/motilal-sold.pdf` are one synthetic pair with a text
layer: a CAS that sells `INE000000002` and the broker summary that funds it.
`node scripts/render-gate-fixture.mjs` drops them through the real inbox. No test
parses them, so they stay out of `samples.mjs`.

`node scripts/render-import-password.mjs` drops `pdf/locked-synthetic.pdf` and
guesses a wrong password four times. It fails unless the fifth attempt is still
offered as `Try the password again` beside `Remove`, then unlocks once to prove
the same entry is re-read rather than duplicated.

## Manifest

`import-manifest.json` is optional. It pins the expected kind and a lower bound
on parsed rows, or payout groups for a cashflow report:

    {
      "files": [
        { "name": "tradebook.xlsx", "kind": "zerodha-tradebook", "minRows": 1 },
        { "name": "holdings.csv", "kind": "digifinn-portfolio", "minRows": 1 }
      ]
    }

Without a manifest every supported file is detected and parsed, and the summary
is printed. Unknown files are listed, not failed.
