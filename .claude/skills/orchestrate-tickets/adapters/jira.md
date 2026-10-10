# Adapter: Jira (tracker)

Tool: the `atlassian` MCP server (`mcp__atlassian__jira_*`).

**Gate:** `jira_get_transitions` on one ticket key from the batch. Answers → present.

| Move | Call |
|---|---|
| List | `jira_search` with the playbook's `query` (JQL), fields `summary,description,status,issuetype,labels,comment` |
| Read | `jira_get_issue` with comments. Read the comments: they are usually the better spec. |
| Transition | `jira_transition_issue` with the id the playbook maps to the logical state |
| Check a state | `jira_get_transitions` lists what is valid from the current status |

- **Transition ids are per workflow.** Re-read `jira_get_transitions` before assuming the
  playbook's ids apply to another project.
- **Many workflows refuse to skip a state**, and the error only says "not valid for the
  current state", which reads like a permissions problem. Move `implemented` before
  `in-review`.
- Ticket link for prompts: `<base url>/browse/<KEY>`.
- A description written as `Now:` / `Cause:` / `Expected:` is the whole spec. Do not copy it
  into the repo; it drifts.

**Forbidden calls:** `jira_add_comment`, `jira_edit_comment`, `confluence_add_comment`,
`confluence_reply_to_comment`, and every other comment or reply call. Also no `jira_update_issue`
of the description or summary: the ticket text is the humans'.
