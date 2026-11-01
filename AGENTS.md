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
