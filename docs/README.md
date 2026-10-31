# Documentation pipeline

The docs have two kinds of content, and only one of them is generated.

| Kind | Examples | Source of truth | Updated by |
|---|---|---|---|
| Derived | schema diagrams, core module graph, route table, test counts | the code | `generate.mjs` |
| Authored | import gate, backup protocol, OAuth flow, prose decisions | a person | review |
| Rendered | every `.svg` in `diagrams/` | the `.mmd` beside it | `render.mjs` |

A generator can prove a table exists or that a module imports another. It cannot infer why
the import gate records a break instead of rejecting it. Trying to generate the second kind
with an LLM produces confident prose that drifts faster than the code, so those diagrams are
authored and checked, not invented.

## Local commands

Install the docs tooling once. The app itself still has no dependencies and no build step.

```bash
npm ci --prefix scripts/docs
```

Rewrite the generated files and render every diagram:

```bash
node scripts/docs/generate.mjs --write
node scripts/docs/render.mjs
```

Check without writing, which is what CI does on a pull request:

```bash
node scripts/docs/generate.mjs --check
node scripts/docs/render.mjs --check
```

`generate.mjs --check` runs the web and worker test suites so the counts are real. A test
failure fails the docs check. `render.mjs --check` fails on a stale SVG or an SVG whose
`.mmd` source was deleted.

## What is generated

`generate.mjs` reads the code and writes five files:

- `diagrams/schema-ledger.mmd` and `diagrams/schema-assets.mmd`, parsed from the `SCHEMA`
  string plus the columns `migrate()` adds. A new table, a new foreign key or a new
  migrated column fails the check until the generator is told about it.
- `diagrams/modules.mmd`, from the imports among the ten core modules.
- `generated/routes.md`, from the route switches in `web/server.mjs`,
  `worker/src/index.js` and `scripts/pages/_worker.js`. A new route fails until it has a
  note in `ROUTES`.
- `generated/facts.md`, with test counts, table count, module count and route count.

These are the drift guards. If the code changes shape and the docs are not updated, the
check fails with the exact file and the missing note.

## What is rendered

`render.mjs` runs every `.mmd` through Pele, the same Mermaid renderer the atlas uses, and
writes an SVG beside it with a fixed light theme. SVG is used instead of PNG because it is
text, diffs cleanly, stays sharp, and needs no browser in CI.

The authored sources are:

- `deployment.mmd`
- `import-flow.mmd`
- `persistence.mmd`
- `oauth-drive.mmd`
- `key-envelope.mmd`
- `backup.mmd`

Edit the `.mmd`, run the renderer, commit both files. Do not edit an `.svg` by hand.

## The workflow

`.github/workflows/docs.yml` runs on every push and pull request:

1. Check out the repository.
2. Install Node 20 and the pinned docs tooling (`npm ci --prefix scripts/docs`).
3. Regenerate the derived files and render the diagrams.
4. On a pull request, `git diff --exit-code -- docs` fails when either step changed
   anything. The contributor must run the two commands and commit the result.
5. On `main`, the workflow commits the regenerated files itself, with `[skip docs]` in the
   message so a second bot commit cannot follow it.

Why the split? A pull request should be reviewed as a complete change, including its docs.
Auto-committing to a pull request would hide generated changes from the reviewer and would
fail for forks, whose token cannot write. On `main`, there is no reviewer waiting, so the
bot can keep the branch current.

The commit step needs `contents: write`. If branch protection blocks direct pushes, set the
repository variable `DOCS_AUTOCOMMIT` to `false` and let the pull-request check do the work
instead. The workflow then fails on stale docs rather than committing them.

## Adding a route, table, module or diagram

- **A route.** Add it to `ROUTES` in `generate.mjs` with its method, where it runs and one
  sentence. The check tells you the exact key it expected.
- **A table or migrated column.** Add it to `SCHEMA_GROUPS`, `RELATIONS` or
  `EXTRA_COLUMNS`. The check names the missing entry.
- **A core module.** Add it to `MODULES` with its layer and a short role.
- **An authored diagram.** Add the `.mmd` file to `docs/diagrams/` and reference the SVG
  from `ARCHITECTURE.md`. The renderer picks it up automatically.

## What this does not do

- It does not rewrite prose. A model summary of a diff is a guess about intent, and the
  docs are the place where intent is recorded.
- It does not deploy a docs site. The Markdown is read on GitHub; a site would be a
  separate `pages` workflow.
- It does not check Markdown links. That is the next cheap guard if link rot appears.
- It does not run on a schedule. A dependency or external API change that alters the
  architecture still needs a person to update the authored diagrams.

The rule of thumb: if the fact can be computed from the repository, generate it. If it is a
decision, write it down and make the check prove the code still matches the decision.
