# Testing policy

Risk-based. A test exists to protect a behaviour a user depends on, not to raise coverage.

## Keep rule

A committed test must belong to at least one group:

| Group | Meaning |
|---|---|
| User-visible | If it breaks, a user sees wrong output, loses work, or is blocked. |
| Regression | It reproduces a bug that was fixed: it fails before the fix and passes after. |
| Contract | It pins a boundary between packages (daemon ↔ protocol ↔ web wire shapes, adapter parsing of recorded fixtures). |

Tests written while building to explore branches are allowed. Before commit, delete every test outside these groups.

## Risk

Risk = user impact × usage frequency. Technical areas (protocol, concurrency, remote sides) are not risks by themselves; test them when a failure there causes one of the impacts below.

| Frequency \ Impact | Data loss, security, user blocked | Wrong and visible to the user | Wrong, hard for the user to notice |
|---|---|---|---|
| Frequently used flow | Unit + E2E | Unit + E2E | Unit |
| Rarely used flow | Unit (always required) | Unit | No test |

Raise the impact one level when:

| Factor | Examples |
|---|---|
| Not undoable | Rollback, worktree remove, stash drop, file delete |
| Silent failure (wrong result, no error) | Transcript missing a part, wrong diff, commit missing files |
| External dependency changes format | Claude Agent SDK, OpenCode, git output: contract test on recorded fixtures |
| First run (install, login, setup) | Provider login, side install error, launcher settings |
| Platform-specific | Windows/WSL paths and shells, 390px layout |

Order of pruning only, not keep or delete: high churn, past bug density and complex logic (state machines, async) are pruned last.

## Rules

1. No test only to raise coverage.
2. Before adding a test, search for an existing test of the same behaviour; extend it instead.
3. Test observable behaviour (output, rendered DOM, emitted messages, files on disk), not internals (private functions, call counts, state shape).
4. One layer owns each behaviour. Unit: logic and edge cases. Contract: wire shapes. E2E: the happy path of a critical journey. Do not repeat edge cases in E2E.
5. No tests of trivial getters/setters, type-only code, or framework/library behaviour.
6. Bug fix: exactly one regression test at the lowest layer that reproduces the bug.
7. Parameterize (`it.each`, Scenario Outline) when the same behaviour runs with different input. Do not merge unrelated behaviours into one table.
8. Changed behaviour: update the existing test. A new test file only for a new module.
9. E2E only for the critical journeys below.
10. The PR description states, per new test, the risk it covers. Test names state the behaviour; no risk comments in code.
11. A flaky test is fixed or deleted. No retry to hide it.

## Critical user journeys (E2E scope)

Draft; the owner confirms changes to this list.

1. Start a session, send a prompt, see the reply, stop a turn.
2. Permission request: allow, always allow, deny.
3. Session restore after daemon restart and client reconnect.
4. Changes: view diff, commit, rollback.
5. Git: checkout branch, stash, resolve a conflict, graph actions.
6. Worktree: create, open, remove.
7. Files: open a file tab, find and replace in files.
8. Terminal: open, run a command, send output to chat.
9. SSH host side: attach, reattach, survive a disconnect.
10. OpenCode engine: provider login, pick a model, prompt, permissions.
11. Orchestration: start a worker, answer its question, read its result.
12. Narrow layout (390×844): the journeys above stay usable.

A scenario that maps to none of these journeys is moved to a unit test or deleted. A ticket's acceptance criterion outside these journeys is verified by the UI tester's run and screenshots; its scenario is deleted before commit.

## Existing suite

The suite predates this policy. It is pruned one package at a time (`web`, `daemon`, `protocol`, `e2e`): score each test against the keep rule, delete or merge the rest, one PR per package.

- Unsure whether a test is in a keep group: keep it and list it in the PR description for the owner to decide.
- Regression tests have no marker: find the commit that added the test (`git log --follow`, `git blame`). Added by a bug fix (issue labelled bug, or a fix commit): keep.
- UI style tests: keep accessibility and layout checks (contrast, touch target size, no horizontal scroll at 390px). Delete tests that pin a className or a specific token value; screenshots cover those.
- No coverage threshold. Track unit cases per 1k source LOC and suite run time instead.
