# Adapter: GitHub Actions (CI)

Tool: the `gh` CLI.

**Gate:** `gh auth status` succeeds and `gh run list --limit 1` answers in the repo.

Watch instructions (paste into the build-watch prompt):

```
- Find the runs for the pushed commit:
  gh run list --branch <remote-branch> --commit <sha> --json databaseId,workflowName,status,conclusion
  None yet: wait a minute and list again (a few tries). Not found yet is not a failure.
- Watch each run to the end: gh run watch <id> --exit-status
- Red: gh run view <id> --log-failed > <scratch>/<KEY>/build-<id>.log
- Every workflow run for the commit must be green for RESULT: succeeded.
```

**Forbidden:** `gh run rerun`, `gh run cancel`, `gh workflow run`, editing workflow files.
