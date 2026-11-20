## Agent skills

### Issue tracker

GitHub Issues on `cuonghuunguyen/claude-code-ui`, via `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.

## Testing policy

Risk-based; full policy and critical journey list in `docs/testing.md`.

- Commit a test only if it is user-visible, a regression test of a fixed bug, or a package contract. Delete exploratory branch tests before commit.
- Search for an existing test of the behaviour first; extend it.
- E2E only for the critical journeys in `docs/testing.md`.
- PR description states the risk each new test covers.

## Talking to the user about tickets and PRs

The user does not read ticket or PR numbers. Name every ticket and PR by its title or a short description of it (`Inline session`, `Graph tags + signing`). Never use a number as the reference (`#455`, `GH-455`, `PR #751`, `stacked on #745`), not even in parentheses. Exception: a command the user must run, or a link, may contain the number. Applies to chat, tables, lists and status reports. Prompts sent to workers may still use numbers.

## Before every push: scan for internal and personal data

This repo is public. Before `git push`, scan the added lines of the outgoing commits (`git diff origin/<base>...HEAD | grep '^+'`): code, tests, fixtures, docs, commit messages.

- Remove: employer or client hostnames and URLs, internal project keys, repo names, ticket keys of other trackers, real people's names or emails, usernames, home paths, IPs, tokens, keys, passwords.
- Replace with neutral values: `example.com`, `acme.atlassian.net`, `proj/repo`, `PROJ-123`, `alice@example.com`.
- Allowed: this repo's own name and GitHub URLs, public hosts (`github.com`, `gitlab.com`, `bitbucket.org`), protocol defaults (Bitbucket port 7999).
- Found and not removable: do not push; ask the user.

## Subagent model selection (orchestrator)

Every `Agent`/worker dispatch sets `model` explicitly, at every spawn depth. Never rely on inheritance.

| Task | Model |
|---|---|
| Search, locate code, read logs, status checks, triage/labeling | `haiku` |
| Mechanical run/extract/summarize where only the result matters (test run, log grep, CI triage) | `inline_task` tool, no `Agent` |
| Implement from a concrete plan, write tests, mechanical refactor, apply review findings, capture UI evidence from a checklist | `sonnet` |
| Plan/design, ambiguous or cross-package issues, code review, review+acceptance verdict, hard root-cause debugging | `opus` |

- `haiku` never edits code.
- Escalate one tier after a failed worker result or two review rejects; do not retry on the same model a third time.
- Unsure between two tiers: pick the lower one when the output is checked by an `opus` review later, the higher one otherwise.
- Issue work: stages and models in `plugins/orchestration/skills/orchestrate-tickets/SKILL.md` section 1.

Ticket playbook: .claude/skills/implement-issue/SKILL.md
