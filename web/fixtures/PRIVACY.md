# Fixture privacy

Fixtures are synthetic. Never add a real statement, database, denylist or identifier.

Real statements are read only through `BANKPIPE_PRIVATE_IMPORT_DIR`. They never enter `web/fixtures/` or any other tracked path.

Binary fixtures are rejected unless they appear in the allowlist in `web/import-regression.test.mjs`. Every fixture file stays under 64 KB.

Regenerate the local denylist after adding statements:

    BANKPIPE_PRIVATE_IMPORT_DIR="$HOME/statements" node web/tools/privacy-denylist.mjs

The denylist stays in `web/private/` and is gitignored.
