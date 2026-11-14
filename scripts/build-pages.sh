#!/usr/bin/env bash
# Builds the Cloudflare Pages bundle: the static app, plus the OAuth broker
# running on the same origin as a Pages advanced-mode worker.
#
#   bash scripts/build-pages.sh
#   cd build/pages && npx wrangler pages deploy
#
# Secrets are NOT in this repo. Set them once per project:
#   npx wrangler pages secret put CLIENT_SECRET --project-name bankpipe
#   npx wrangler pages secret put COOKIE_KEY     --project-name bankpipe
# Pages applies new secrets only to new deployments, so redeploy after changing them.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/build/pages"

rm -rf "$OUT"
mkdir -p "$OUT/public/broker"

# The app. private/ holds real account metadata and must never be published.
rsync -a "$ROOT/web/" "$OUT/public/" \
  --exclude 'private/' \
  --exclude '*.test.mjs' \
  --exclude 'fixtures/' \
  --exclude 'tools/' \
  --exclude '*.pdf' \
  --exclude '*.bpk' \
  --exclude '*.db' \
  --exclude '*.db-wal' \
  --exclude '*.db-shm' \
  --exclude '*.sqlite' \
  --exclude 'import-denylist.txt' \
  --exclude 'server.mjs' \
  --exclude 'README.md' \
  --exclude 'node_modules/'

# The broker, unchanged, so the tests cover what is deployed.
cp "$ROOT/worker/src/lib.js" "$ROOT/worker/src/index.js" "$OUT/public/broker/"

# Same-origin router + project config.
cp "$ROOT/scripts/pages/_worker.js" "$OUT/public/_worker.js"
cp "$ROOT/scripts/pages/market.js" "$OUT/public/market.js"
cp "$ROOT/scripts/pages/wrangler.jsonc" "$OUT/wrangler.jsonc"

# A version a person can read out over the phone. `git archive` carries no .git,
# so the commit arrives as BP_COMMIT from whoever deploys; without it the date
# still identifies the build.
STAMP="$(date -u +%Y.%m.%d)"
COMMIT="${BP_COMMIT:-}"
node "$ROOT/scripts/version-assets.mjs" "$OUT/public" "${COMMIT:-$STAMP}"
BUILT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > "$OUT/public/version.json" <<JSON
{"version":"$STAMP","commit":"$COMMIT","built":"$BUILT"}
JSON

node "$ROOT/scripts/check-pages-privacy.mjs" "$OUT/public"

echo "built $OUT"
