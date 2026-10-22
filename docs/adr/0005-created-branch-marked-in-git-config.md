# Created branch is marked in git config, not by name prefix

Deleting a worktree must delete the branch claude-ui created for it (a Created branch) and keep any other branch. Until GH-447 the rule was the name: every created branch was `worktree-<name>`, and removal deleted `worktree-*` branches with `-D`. The Create worktree modal names branches from a Jira ticket (`feature/PRJ-1-login`) or a free name (`fix-login`), so the prefix can no longer tell. Every branch claude-ui creates (Create worktree modal, quick create, orchestration `worker_start`) now gets `branch.<name>.claudeUiCreated = true` in the repository's git config, written right after `git branch` under the repository lock. Removal deletes a marked branch (and a legacy `worktree-*` one) with `-D`; `worktree.status` counts its commits as what removal loses, so the remove dialog warns first.

## Considered options

- **`worktree-` name prefix** (the old rule): breaks team branch conventions (`feature/…`, ticket keys) and marks a branch a user named `worktree-x` by hand as ours.
- **Daemon-side store** (a list in the config dir): lost with the config dir, not shared by daemons of other users or machines on the same repository, and out of date when a branch is renamed or deleted with git directly.
- **git config mark** (chosen): lives with the repository, every claude-ui daemon on it sees it, `git branch -m` moves it and `git branch -d/-D` removes it with the branch section.

## Consequences

- A held `config.lock` is retried a few times; when the write still fails, the create succeeds without the mark (warning in the daemon log) and that branch is kept on delete like a user's branch.
- A user can mark or unmark a branch by hand (`git config branch.<name>.claudeUiCreated true|false`).
- An existing branch checked out through the Branch source is never marked: deleting its worktree keeps it unless the user asks and it is merged.
