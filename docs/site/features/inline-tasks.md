# Inline tasks

An inline task is a mid-size job that Claude runs inside one tool call. A small model with a minimized context does the work with the tools it is granted and returns only the result. Your session's context grows by the result, not by every intermediate output.

An inline task is not a session: it has no entry in the session list and no transcript of its own. It appears as a card under the `inline_task` tool call.

## When to use it

The agent reads these rules (the same text is its guidance):

> Use inline_task when the task:
> - needs 3-10 tool calls and only the result matters;
> - needs no parent conversation context beyond what fits in prompt + files;
> - is mechanical: run, extract, summarize, classify, format, small edit.
>
> Use a subagent instead when the task needs judgment or design, long exploration, parallel runs, or parent context.
> Do it directly when 1-2 tool calls suffice, or when the next step needs the raw output.
>
> Grant the least: tools default to Read, Grep, Glob; add Bash, Write, Edit or an MCP server only when needed.

## Scenarios

| Scenario | The inline task does | Returns |
| --- | --- | --- |
| Environment setup | Several Bash calls: install dependencies, create config, start a service, check the port | Done or failed, with the output of the failing step |
| Drive Playwright (MCP or CLI) | Opens a page, clicks through steps, takes screenshots | Pass or fail per step, screenshot paths |
| Log extraction | Greps and reads large logs, correlates timestamps | The lines or values asked for |
| CI failure triage | Fetches a CI log (Jenkins, GitHub Actions), finds the first error | Failing test, error message, file:line |
| Test run | Runs the test suite, parses the output | Only the failures, with message |
| Pre-push scan | Reads `git diff origin/<base>...HEAD`, checks added lines for hostnames, names, tokens, home paths | Findings with file:line, or clean |
| Git chores | Rewrites commit times, cherry-picks, writes a commit message from the diff | Result and new SHAs |
| Tracker fetch | `gh issue view` with comments and linked PRs | Short summary of the ticket state |
| Docs lookup | Context7 or web docs query | The exact API signature or config snippet |
| Code location | Grep and Glob over the repo for call sites of a symbol | List of file:line |
| Mechanical edit | Renames in a few files, updates imports, applies lint autofix, updates snapshots | Files changed and check result |
| License check | Reads a dependency's package metadata and LICENSE | License and compliance note |
| Data conversion | Parses JSON, YAML or CSV output into the shape the caller needs | Converted data |
| Worker status | Reads an [orchestration](orchestration) worker transcript | Status and open question |

## The card

The card sits under the tool call. It shows the status, the task, and `model · turns · tokens`. While it runs, **Stop** cancels the task; the result then comes back as stopped, with what was done so far.

- **Steps** (tools the task called) are collapsed. Open them to follow the work.
- The **result** is shown as text, with the list of changed files.
- A permission request of the task shows in the session like any other, and the card opens on it. See [Permissions & modes](permissions).

## What the task can use

- Tools: `Read`, `Grep` and `Glob` by default. `Bash`, `Write`, `Edit` and MCP servers of the session (for example Playwright) only when the agent grants them.
- Permissions: the mode and rules of the session apply to every tool call. The task never gets more than the session has.
- No hooks, no CLAUDE.md, no memory, no skills. PreToolUse and other hooks of the parent do not run inside an inline task. The task never starts other agents, and never gets the claude-ui or orchestration tools.
- Account: the same as the session (subscription or API key). No separate key.

## Limits

| Limit | Value |
| --- | --- |
| Turns | 10 by default, at most 30 |
| Output tokens | 16,000 |
| Time | 10 minutes |
| Running at once | 3 per session |
| Prompt | 20,000 characters |
| Files given to the task | 20 files, 64 KB each, 256 KB in total |

At a limit the task stops and returns the partial result with the reason (turns, tokens or time).

## Settings

In **Settings › Sessions › Inline tasks**:

| Setting | Default | Meaning |
| --- | --- | --- |
| Enabled | On | Off: turns that start later have no `inline_task` tool |
| Model | `haiku` | Model for Claude Code sessions |
| OpenCode model | empty | `provider/model` for OpenCode sessions. Empty: OpenCode's `small_model`, else the session's model |
| Max turns | 10 | Default turn limit, 1 to 30 |

## Good to know

- Steps are kept only while the daemon runs. After a restart or a reload the card shows the result, model, turns, tokens and files, and the note "Steps are not kept after the daemon restarts."
- Rewinding the code of a session does not undo files an inline task changed.
- The list of changed files comes from the Edit and Write steps and from `git status`. A file that was already modified before the task and changed again only by a Bash command is not listed. Outside a git repository only Edit and Write steps count.

## OpenCode sessions

Inline tasks work in OpenCode sessions with these gaps:

- OpenCode keeps its base prompt and `AGENTS.md`, so the context is smaller by tools and history only, not by instructions.
- The turn limit is enforced after the turn by stopping the task, not by the model.
- If the call cannot be matched to the running call, the task still runs and returns its result, but the card has no steps.
