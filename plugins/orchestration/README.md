# orchestration plugin

Worker-tree ticket pipeline for [claude-ui](https://github.com/cuonghuunguyen/claude-code-ui): four agent types and the `orchestrate-tickets` skill.

## Install

```
claude plugin marketplace add cuonghuunguyen/claude-code-ui
claude plugin install orchestration@claude-ui
```

Development from a checkout: `claude plugin marketplace add <path of the checkout>` or `claude --plugin-dir plugins/orchestration`. Validate: `claude plugin validate --strict .` and `claude plugin validate --strict plugins/orchestration`.

The repo's `.claude/settings.json` lists `orchestration@claude-ui` in `enabledPlugins` with the marketplace `cuonghuunguyen/claude-code-ui` as a GitHub source: that loads the plugin from GitHub (the merged default branch), **not** from the local checkout. To test local edits use the local marketplace add or `--plugin-dir` above.

An installed plugin is a copy: a change reaches users after it is merged and `claude plugin update` runs.

## Agent types

| Agent | Model | Does |
|---|---|---|
| `orchestration:planner` | opus | Plans one ticket, no code |
| `orchestration:implementer` | sonnet | Builds test-first, commits, starts its own verifiers, runs the fix loop |
| `orchestration:ui-tester` | sonnet | Verifies a commit through the real UI with screenshots |
| `orchestration:reviewer` | opus | Read-only review of a commit with `pr-review` (`disallowedTools`: Edit, Write, NotebookEdit) |

No agent file declares `tools:` (a tool list drops the orchestration MCP tools) or `permissionMode`: an SDK probe (SDK 0.3.285, CLI 2.1.294) showed that `permissionMode` in an agent file is ignored for a main-thread agent (the session mode is the `worker_start` mode, or `default` when none is given), so the mode ceiling cannot be raised by an agent file. The planner, ui-tester and reviewer have `mcp__orchestration__worker_start` in `disallowedTools`: only the implementer starts workers. The input of every role is the HANDOFF block (`skills/orchestrate-tickets/references/handoff.md`).

Start one with the claude-ui `worker_start` tool: `agent: "orchestration:reviewer"` (a bare name works when it is unique). An explicit `model` wins over the agent's model.

## Requirements

- claude-ui with Settings › Orchestration › Enable orchestration on, and **Maximum tree depth** 2 or more (default 2) for the tree flow. **Maximum workers per coordinator** (default 4) and **Maximum workers** apply.
- Skills installed separately: `pr-review` (reviewer), `playwright-cli` (ui-tester), `tdd` (implementer, soft).
- A repo playbook (this repo: `.claude/skills/implement-issue`).

## Flow

Root coordinator starts planner and implementer; the implementer starts ui-tester and reviewer, loops on red, joins on one commit, and reports. See `skills/orchestrate-tickets/references/tree-flow.md`. Without the agent types the skill's hub flow still works.
