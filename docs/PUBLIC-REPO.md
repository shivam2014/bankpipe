# Making the repository public

The files are clean. The history is not. This page is the order of operations for
backing it up, rewriting it, proving the rewrite, publishing every ref, and asking
GitHub to drop what a force-push cannot reach. Do not skip a step because the tree
check passes: the tree check never reads old commits.

The repository stays private until step 8. The rewrite itself is a separate,
deliberate action; this page only prepares the rails.

## What you need

- A clean checkout on the main worktree, with every local branch fetched.
- `git-filter-repo` (install it with your package manager; `pipx install
  git-filter-repo` is one option) and `gh` authenticated as an administrator.
- Disk space for at least two mirrors, one archive and one verification clone.
- An encrypted destination outside the repository, plus a copy on another device.
  The examples use `$HOME/bankpipe-backups` and `$HOME/bankpipe-private`; neither
  is tracked, and neither may ever be committed.

## 1. Back up every ref

From the main checkout:

```bash
scripts/backup-mirror.sh
```

That one line clones the local repository as a bare mirror, so it includes every
local branch, every tag and the local `refs/t3/*` checkpoints. It runs
`git fsck --full`, writes a ref manifest, makes a compressed archive and writes a
SHA-256 of the archive.

To also capture the exact GitHub view, run it once more against the remote:

```bash
scripts/backup-mirror.sh git@github.com:shivam2014/bankpipe.git "$HOME/bankpipe-backups"
```

A run produces, under `$HOME/bankpipe-backups`:

```
bankpipe-<UTC>.git/                 the mirror, all refs
bankpipe-<UTC>.refs.txt             every ref name and object id, plus commit count
bankpipe-<UTC>.tar.gz               the mirror as one file
bankpipe-<UTC>.tar.gz.sha256        the checksum
```

Verify the archive and drill a restore before changing anything:

```bash
cd "$HOME/bankpipe-backups"
shasum -a 256 -c bankpipe-<UTC>.tar.gz.sha256    # sha256sum -c on Linux
tar -tzf bankpipe-<UTC>.tar.gz >/dev/null
git clone --mirror bankpipe-<UTC>.git restore-drill.git
git -C restore-drill.git fsck --full
git -C restore-drill.git rev-list --all --count
rm -rf restore-drill.git
```

Keep the mirror and the archive; copy both the archive and its checksum to an
encrypted disk that is not the working machine. A backup that has only ever been
written is a rumour.

## 2. Record the current public refs and leaks

Before rewriting, snapshot what GitHub currently publishes and what the history
checker finds:

```bash
mkdir -p "$HOME/bankpipe-private"
git ls-remote --heads --tags origin > "$HOME/bankpipe-private/public-refs-before.txt"
node scripts/check-history-privacy.mjs --messages \
  > "$HOME/bankpipe-private/history-before.txt" 2>&1 || true
```

Read `history-before.txt`. It names a commit and path, never the value. Keep the
commit ids for the support request:

```bash
awk '/commit [0-9a-f]+/ { print $2 }' "$HOME/bankpipe-private/history-before.txt" \
  | sort -u > "$HOME/bankpipe-private/old-leak-shas.txt"
```

Build the replacement list from the local denylist plus anything the report reveals
that the denylist missed:

```bash
awk 'NF && $0 !~ /^#/ { print "literal:" $0 "==>REDACTED" }' \
  "$HOME/bankpipe/web/private/import-denylist.txt" \
  > "$HOME/bankpipe-private/replacements.txt"
```

Inspect that file. Keep it outside the repository. If a leaked value is not in the
denylist, add a `literal:` or `regex:` line for it here, not in the allowlist.

## 3. Rewrite a copy, never the live checkout

Work from a fresh mirror so a mistake cannot touch the checkout you are using:

```bash
rm -rf "$HOME/bankpipe-rewrite"
git clone --mirror "$HOME/bankpipe-backups/bankpipe-<UTC>.git" "$HOME/bankpipe-rewrite.git"
cd "$HOME/bankpipe-rewrite.git"
```

Remove leaked paths first. List every path that ever held a statement, database
or denylist:

```bash
git filter-repo --force --invert-paths \
  --path path/that/leaked \
  --path another/path/that/leaked
```

Then replace the identifiers in every remaining blob:

```bash
git filter-repo --force --replace-text "$HOME/bankpipe-private/replacements.txt"
```

Then replace the same values in commit messages:

```bash
git filter-repo --force --replace-message "$HOME/bankpipe-private/replacements.txt"
```

Each pass rewrites every ref and changes every downstream hash. That is expected.
Do not combine the path pass with the text passes; run them in this order and
check the result after each one. Never use `git filter-branch` here.

## 4. Verify the rewrite

In the bare mirror:

```bash
git fsck --full
node "$HOME/bankpipe/scripts/check-history-privacy.mjs" --messages
```

The checker must print `clean`. If it does not, add the missing value to the
replacement file and run the text pass again on a fresh copy.

Then make a normal clone and verify the tree and the full suite:

```bash
rm -rf "$HOME/bankpipe-verify"
git clone "$HOME/bankpipe-rewrite.git" "$HOME/bankpipe-verify"
cd "$HOME/bankpipe-verify"
node "$HOME/bankpipe/scripts/check-privacy.mjs"
cd web && node --test
```

Confirm the old leaked commits are gone. Pick a commit from `history-before.txt`;
this must fail:

```bash
git -C "$HOME/bankpipe-verify" cat-file -e <old-sha> && echo "STILL PRESENT" || echo "gone"
```

Compare the ref manifest with the rewritten refs. The names must match; the object
ids must not:

```bash
git -C "$HOME/bankpipe-rewrite.git" for-each-ref \
  --format='%(refname) %(objectname)' > "$HOME/bankpipe-private/refs-after.txt"
diff <(cut -d' ' -f1 "$HOME/bankpipe-backups/bankpipe-<UTC>.refs.txt" | sort) \
     <(cut -d' ' -f1 "$HOME/bankpipe-private/refs-after.txt" | sort)
```

## 5. Force-push every public ref

Point the rewritten mirror at GitHub and push the exact refs that were public
before the rewrite. Do not use `--mirror`: it would also publish local-only
branches and `refs/t3/*` checkpoints that were never public.

```bash
cd "$HOME/bankpipe-rewrite.git"
git remote add origin git@github.com:shivam2014/bankpipe.git 2>/dev/null \
  || git remote set-url origin git@github.com:shivam2014/bankpipe.git
cut -f2 "$HOME/bankpipe-private/public-refs-before.txt" \
  | grep -v '\^{}' \
  | while read -r ref; do
      case "$ref" in
        refs/heads/*|refs/tags/*) git push --force origin "$ref:$ref" ;;
      esac
    done
```

If branch protection blocks the push, disable the rule for the duration, push,
and re-enable it immediately. Verify the remote object ids against
`refs-after.txt`:

```bash
git ls-remote --heads --tags origin > "$HOME/bankpipe-private/public-refs-after.txt"
```

If you genuinely intend to publish every local branch, use the wider form and
accept that the local-only work becomes public:

```bash
git push --force --prune origin \
  'refs/heads/*:refs/heads/*' 'refs/tags/*:refs/tags/*'
```

Do not push `refs/t3/*`. Those are local orchestration checkpoints, not part of
the public repository. Keep them until the rewrite is verified, then delete them
locally if they are no longer needed.

## 6. Re-clone the checkouts and worktrees

Every existing clone still has the old objects and hashes. Stop agents and T3
threads first, then commit or stash real work. `git worktree remove` refuses a
dirty worktree on purpose; do not force it until you have looked at the diff.

```bash
cd "$HOME/bankpipe"
git worktree list --porcelain \
  | awk '/^worktree / { print substr($0, 10) }' \
  | tail -n +2 \
  | while read -r path; do
      git worktree remove "$path" || echo "kept dirty worktree: $path"
    done
git worktree prune

git fetch --all --prune --tags --force
```

Update the main checkout and the local branches that still have a public remote:

```bash
git switch main
git reset --hard origin/main

git for-each-ref --format='%(refname:short)' refs/heads \
  | while read -r branch; do
      if git rev-parse --verify -q "origin/$branch" >/dev/null; then
        git branch -f "$branch" "origin/$branch" || echo "skip checked-out branch: $branch"
      else
        echo "local-only branch kept: $branch"
      fi
    done
```

A local-only branch still points at the old history. Either delete it after the
backup, or rebase it onto the rewritten base; never push it as-is. Start the T3
threads again from the rewritten repository so their worktrees are created from
the new commits.

After the old history is no longer needed locally, expire it so a later command
cannot resurrect it:

```bash
git for-each-ref --format='delete %(refname)' refs/t3 | git update-ref --stdin
git reflog expire --expire=now --all
git gc --prune=now
```

The backup mirror and archive are the only copies of the old history you should
keep. Do not run the cleanup before the backup and verification pass.

## 7. Confirm the repository is ready to be public

Before flipping visibility:

- The history checker prints `clean` on the rewritten mirror.
- `node scripts/check-privacy.mjs` and `cd web && node --test` pass on a fresh
  clone of the rewritten history.
- The ref names in `refs-after.txt` match what you intend to publish.
- `public-refs-after.txt` on GitHub has the new object ids, not the old ones.
- Actions secrets and workflow triggers have been reviewed for a public
  repository. A public fork can run pull-request workflows with the read token;
  secrets are not exposed to it, but `pull_request_target` and write-token jobs
  need a deliberate look.
- Existing forks are listed. A fork keeps the old history and a force-push does
  not clean it.

## 8. Flip visibility

```bash
gh repo view shivam2014/bankpipe --json visibility,isPrivate
gh repo edit shivam2014/bankpipe \
  --visibility public \
  --accept-visibility-change-consequences
gh repo view shivam2014/bankpipe --json visibility
```

The last command must report `PUBLIC`.

## 9. Ask GitHub to purge what a force-push cannot

A force-push changes the refs. It does not immediately delete cached views,
unreachable objects, pull-request refs or forks. GitHub's own guidance is to
contact Support to purge cached views and unreachable objects after a sensitive
history rewrite. Open a support request for `shivam2014/bankpipe` with the old
commit ids from `history-before.txt` and ask for both:

1. a purge of cached views of the old commits;
2. a purge of unreachable objects reachable only from the old refs.

Until that completes, an old commit can still resolve by SHA in the API, a raw
URL or a cached page. Check the old ids:

```bash
for sha in $(cut -d' ' -f1 "$HOME/bankpipe-private/old-leak-shas.txt"); do
  curl -s -o /dev/null -w "%{http_code} $sha\n" \
    "https://api.github.com/repos/shivam2014/bankpipe/commits/$sha"
done
```

Expect `404` after the purge. A `200` means the object is still reachable.

Forks are separate repositories. Delete or ask the owners to delete forks that
contain the old history; GitHub cannot purge a fork you do not control. Pull
request refs also keep old objects; include them in the support request.

## 10. Run the gate on the public repository

From a fresh clone:

```bash
git clone git@github.com:shivam2014/bankpipe.git "$HOME/bankpipe-public-check"
cd "$HOME/bankpipe-public-check"
node scripts/check-privacy.mjs
node scripts/check-history-privacy.mjs --messages
cd web && node --test
```

Then run the `privacy` workflow manually with the `history` input enabled. It
checks out the full history and runs the same history checker in CI.

## Rollback

Set the repository private immediately:

```bash
gh repo edit shivam2014/bankpipe --visibility private
```

That stops new public reads. It does not remove cached copies, forks or clones
that already exist, so the support purge is still required.

To restore the old refs in a disaster, push the backup mirror. `--mirror` deletes
remote refs that are absent locally, so use it only when that is what you mean:

```bash
git clone --mirror "$HOME/bankpipe-backups/bankpipe-<UTC>.git" \
  "$HOME/bankpipe-restore.git"
cd "$HOME/bankpipe-restore.git"
git remote set-url origin git@github.com:shivam2014/bankpipe.git
git push --force --mirror origin
```

## What the checker cannot catch

The checker is a shape detector, not a privacy classifier. It will not catch:

- names, addresses, dates of birth, family relationships or amounts written as
  ordinary text;
- a real statement pasted into an issue, pull request, review comment, release
  note, wiki page, gist or commit message unless you run `--messages`;
- a PDF, screenshot, image, video, Actions log, Actions artifact, LFS object,
  submodule, package or database that is binary or skipped as vendored;
- files over the 16 MB limit, or content reachable only from GitHub pull-request
  refs, forks, unreachable objects or the GitHub cache;
- the difference between an invented value and a real one. The private denylist
  can catch actual values, but it is untracked and absent in CI by design.

The tree check scans tracked text and workbook cells. The history check scans
blobs reachable from local refs. Neither is a substitute for reading the diff and
the report before flipping visibility.
