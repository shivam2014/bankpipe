#!/bin/bash
# Gate before sharing or reading the codebase: no data files may live here.
# The identifier scan is shared with CI and the history checker, so a fixture
# that trips one gate trips all of them.
set -euo pipefail
cd "$(dirname "$0")" || exit 1

found=$(find . -type f \( -name '*.db' -o -name '*.xlsx' -o -name '*.xlsm' -o -name '*.csv' \) \
  -not -path './.git/*' -not -path './.ratchet/*' -not -path './node_modules/*' \
  -not -path './venv/*' -not -path './dist/*' -not -path './build/*' \
  -not -path './web/fixtures/*' 2>/dev/null)
if [ -n "$found" ]; then
  echo "DATA FOUND IN THE CODE TREE:"
  echo "$found"
  exit 1
fi

# Scans tracked text and workbook cells for PAN, Aadhaar, account/demat, IFSC,
# email and phone shapes. Synthetic fixtures are cleared by
# scripts/privacy-allowlist.json; the private denylist is not needed.
node scripts/check-privacy.mjs

echo "clean: no database, workbook or csv in the code tree"
