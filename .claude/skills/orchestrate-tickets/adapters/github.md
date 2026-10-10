# Adapter: GitHub (code host)

Tool: the `gh` CLI.

**Gate:** `gh auth status` succeeds and `gh repo view --json name` answers in the repo.

| Move | Call |
|---|---|
| Push | `git push` with the refspec from `references/delivery.md` (`remote-branch: same` → `<branch>:refs/heads/<branch>`) |
| Open PR | `gh pr create --head <remote-branch> --base <base without origin/> --title "<title>" --body-file <file>` |
| Read a PR | `gh pr view <n> --json url,title,body,headRefName`, `gh pr diff <n>` |

- Write the body to a file under the scratch folder and pass `--body-file`; quoting a long
  body inline breaks.
- `gh pr create` prints the URL; record it in the ledger.

**Forbidden calls:** `gh pr comment`, `gh pr review` (any of `--approve`, `--comment`,
`--request-changes`), `gh pr merge`, `gh pr close`, `gh pr edit --body` after creation, and
comments through `gh api`.
