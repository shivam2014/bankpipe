# Deploy

`bankpipe.pages.dev` is a Cloudflare Pages project named `bankpipe`. It is **not**
connected to GitHub, so a push alone does not redeploy it. `.github/workflows/deploy.yml`
does the build and deploy with Wrangler.

## What the workflow does

On a push to `main`, or a manual run from the Actions tab:

1. Checks out the commit.
2. Runs `bash scripts/build-pages.sh`, which writes `build/pages/` from `web/`, the
   OAuth broker in `worker/`, and the same-origin router in `scripts/pages/`. The
   `private/` directory and test fixtures are excluded.
3. Deploys `build/pages` to the `bankpipe` Pages project on the `main` branch, which is
   the production environment.
4. Polls `https://bankpipe.pages.dev/version.json` until it reports the commit that was
   built. A deploy that exits zero but serves an old commit fails the job.

Pull requests build the bundle but do not deploy and do not need Cloudflare secrets.

## One-time setup

Create a scoped Cloudflare API token:

1. Open <https://dash.cloudflare.com/profile/api-tokens>.
2. **Create Token** → **Custom token**.
3. Permissions: **Account** → **Cloudflare Pages** → **Edit**.
4. Account resources: include the account that owns `bankpipe`.
5. Create the token and copy it once.

Add two repository secrets in **Settings → Secrets and variables → Actions**:

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | the token from the step above |
| `CLOUDFLARE_ACCOUNT_ID` | the account ID from `wrangler whoami` |

The account ID is not sensitive, but keeping it as a secret means the workflow has one
place to read both values.

Then push to `main`, or open **Actions → deploy → Run workflow**. The first run should
finish with `production is <commit>`.

## Your database

The ledger is not on the Pages server. It is in the browser's IndexedDB under
`bankpipe.db.v1`, sealed with your passphrase. A deploy replaces static files on the
same origin; it does not clear or upload IndexedDB.

The Pages project secrets (`CLIENT_SECRET`, `COOKIE_KEY`) also persist across
deployments. `wrangler pages deploy` changes the assets, not the project configuration.

To be extra careful before a deploy, use **Settings → Backup → Back up now** and keep
the encrypted file. That is good practice anyway, not a requirement for this change.

## Rollback

Cloudflare dashboard → **Workers & Pages** → `bankpipe` → **Deployments** → pick the
previous deployment → **Rollback**. The database is unaffected because it never left the
browser.

## Manual fallback

If Actions is unavailable:

```bash
BP_COMMIT="$(git rev-parse --short HEAD)" bash scripts/build-pages.sh
cd build/pages
npx wrangler@4.153.0 pages deploy --project-name bankpipe --branch main --commit-dirty=true
```

Check `https://bankpipe.pages.dev/version.json` afterwards. Its `commit` field must match
`git rev-parse --short HEAD`.

## Secrets and limits

- The token is account-scoped, not a user OAuth token. Do not commit it.
- Wrangler 4.153 requires Node 22 or newer. The workflow uses Node 22; the manual
  fallback needs it too. The Wrangler version is pinned; bump it deliberately when
  Cloudflare changes the deploy format.
- The production verify polls for up to 90 seconds. A slow Cloudflare propagation can
  fail the job even when the deploy eventually succeeds; rerun the job or check the
  deployment URL.
- The workflow only deploys `main`. A manual run from another branch builds the bundle
  but skips the deploy step.
