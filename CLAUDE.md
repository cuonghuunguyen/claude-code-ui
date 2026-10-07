## Agent skills

### Issue tracker

GitHub Issues on `cuonghuunguyen/claude-code-ui`, via `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.

## Subagent model selection (orchestrator)

Every `Agent`/worker dispatch sets `model` explicitly, at every spawn depth. Never rely on inheritance.

| Task | Model |
|---|---|
| Search, locate code, read logs, status checks, triage/labeling | `haiku` |
| Implement from a concrete plan, write tests, mechanical refactor, apply review findings, capture UI evidence from a checklist | `sonnet` |
| Plan/design, ambiguous or cross-package issues, code review, review+acceptance verdict, hard root-cause debugging | `opus` |

- `haiku` never edits code.
- Escalate one tier after a failed worker result or two review rejects; do not retry on the same model a third time.
- Unsure between two tiers: pick the lower one when the output is checked by an `opus` review later, the higher one otherwise.
- Issue work: stages and models in `.claude/skills/orchestrate-tickets/SKILL.md` section 1.

Ticket playbook: .claude/skills/implement-issue/SKILL.md
