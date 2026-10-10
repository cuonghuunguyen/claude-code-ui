# Adapter: Bitbucket Server (code host)

Tool: the `bitbucket` MCP server (`mcp__bitbucket__*`), or the `bb` CLI from the
`bitbucket-review` skill. Use whichever the gate finds; prefer the MCP when both are there.

**Gate:** `mcp__bitbucket__get_current_repo` from the repo, or `bb repo` answers. A server
listed in config but failed at session start is absent.

| Move | Call |
|---|---|
| Push | `git push` with the renaming refspec (`references/delivery.md`) |
| Open PR | `mcp__bitbucket__create_pull_request` with `projectKey`, `repoSlug`, `fromBranch`, `title`, `description`, and `toBranch` only when not the default branch; or `bb pr create` |
| Find project and slug | `mcp__bitbucket__get_current_repo` turns the remote into them |
| Read a PR | `bb pr view`, `bb pr diff`, or the MCP's read calls |

- The branch must exist on the server before the PR call: push first.
- Without a `title`, Bitbucket derives one from the branch name. Always pass one.

**Forbidden calls:** `mcp__bitbucket__add_pr_comment`, `mcp__bitbucket__create_pr_task`,
`bb comment`, `bb task`, `bb review` (draft or publish), approve, needs-work, merge, decline.
