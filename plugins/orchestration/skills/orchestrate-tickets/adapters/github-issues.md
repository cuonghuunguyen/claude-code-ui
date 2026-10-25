# Adapter: GitHub Issues (tracker)

Tool: the `gh` CLI, run inside the repo (it infers the repo from the remote).

**Gate:** `gh auth status` succeeds and `gh issue list --limit 1` answers.

| Move | Call |
|---|---|
| List | `gh issue list --state open <playbook query flags> --json number,title,body,labels,comments` |
| Read | `gh issue view <n> --comments --json number,title,body,labels,comments` |
| Transition | Labels: `gh issue edit <n> --add-label <label> --remove-label <label>`, per the playbook's `states` (`label` or `-old +new`). `—` = no move. |

- Key: `GH-<n>`. Link for prompts: `https://github.com/<owner>/<repo>/issues/<n>`.
- Never close an issue: closing happens when the PR merges, which is the humans' move.

**Forbidden calls:** `gh issue comment`, `gh issue close --comment`, `gh issue edit --body`,
`gh issue edit --title`, and every comment through `gh api`.
