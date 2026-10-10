# Ticket playbook — one per repo

The playbook is everything this skill must not know: which tracker and host, which states,
how branches are named, how to install, test and start the app, what to read before planning,
and the traps that cost a batch before. One markdown file per repo. Workers read it too.

---

## Finding it

In order, first hit wins:

1. **The repo's `CLAUDE.md` names it**: a line `Ticket playbook: <path relative to the repo>`.
   Use this when the repo can carry agent files. Every worker in that repo loads `CLAUDE.md`,
   so they find it without being told.
2. **The user's own folder**: `~/.claude/playbooks/<repo-name>.md`, where `<repo-name>` is the
   last path segment of `git remote get-url origin` without `.git`. For repos where the team
   should not see agent files. Workers do not find this on their own: put its absolute path in
   every prompt.
3. **Neither**: draft one (below). The batch does not start until it exists.

Say which one you found, with its path.

---

## The format

Sections the coordinator reads are fixed; everything else is the repo's own prose for workers.

```markdown
# Ticket playbook: <repo-name>

## Profile
tracker:     jira | github-issues                     → adapters/<tracker>.md
query:       <the tracker's query for "my ready tickets">
states:      started → <id or label>, implemented → <…>, in-review → <…>   (— = no move)
host:        bitbucket | github | none                → adapters/<host>.md
push:        coordinator | ask | never
remote-branch: <pattern, e.g. feature/<KEY>-<slug>, or same>
ci:          jenkins | github-actions | none          → adapters/<ci>.md
base:        <ref, e.g. origin/master>
branch:      <pattern, e.g. <KEY>-<slug>>
scratch:     <path, e.g. development-docs/<KEY>/>  ignored by: <git exclude | .gitignore>
acceptance:  playwright | none (<reason>)
caps:        workers <n>, acceptance <n>              (optional; default 3 and 2)

## Commands
install:     <first thing every worker runs in a fresh worktree>
test:        <full suite>        scoped: <how to run only the tests for a diff>
typecheck:   <command or —>
app:         <start command with a port placeholder>   stop: <how>
ports:       <range acceptance workers may use>

## Plan skip rules
<only when the repo tightens the defaults in references/planning.md>

## Plan: read before designing
<docs, ADRs, code paths, references that every plan must consult>

## Implement
<repo conventions: test style, helpers to reuse, files that must change together>

## Acceptance
<how a human reaches the app, login, test data, what counts as evidence>

## Traps
<numbered; each one paid for once>
```

Rules:

- **`Profile` and `Commands` are required.** A value the drafter could not find is `TODO`, and
  a playbook with a `TODO` in these two sections fails the gate.
- One adapter per role, named exactly as its file in `adapters/`. A role with no tool is
  `none`, which switches its stage off (`SKILL.md` §1). Nothing else switches a stage off.
- `states` uses the three logical states the pipeline moves through: `started` (first worker
  out), `implemented` (acceptance green), `in-review` (PR open). The adapter says what an id or
  label means for its tracker. Done, merged, closed: always the humans' move.
- Keep it short. A playbook is read in full by every worker; a page of prose is a page of
  tokens per worker per stage.

---

## Drafting a playbook

When none exists, start one read-only worker (template `worker-specs.md` §6, `model: sonnet`)
in the repo's main checkout. It reads the README, `CLAUDE.md`, package manifests, CI config
(`Jenkinsfile`, `.github/workflows/`), the git remote and recent branch names, and writes
`<scratch>/playbook-draft.md` in the format above, with `TODO` for what it cannot establish.

Then the coordinator:

1. Fills what the adapters can answer: tracker states from a read-only transitions call on
   one ticket, the host from the remote URL.
2. Shows the user the draft and every `TODO`, as one list of questions.
3. Asks where it goes: the repo (and the `CLAUDE.md` pointer line) or `~/.claude/playbooks/`.
4. Hands the file to the user or to a worker to commit. The coordinator writes no file in the
   repo except the ledger.

---

## Example profiles

claude-ui (playbook in the repo, `.claude/skills/implement-issue/SKILL.md`):

```
tracker: github-issues   states: started → —, implemented → —, in-review → —
host: github   push: ask   remote-branch: same
ci: none   base: main   branch: GH-<n>-<slug>
scratch: <main checkout>/development-docs/GH-<n>/  ignored by: .gitignore
acceptance: playwright
```

ESACA (playbook in `~/.claude/playbooks/esaca-sandbox.md`):

```
tracker: jira   states: started → 91, implemented → 421, in-review → 431
host: bitbucket   push: coordinator   remote-branch: feature/<KEY>-<slug>
ci: jenkins   base: origin/master   branch: <KEY>-<slug>
scratch: development-docs/<KEY>/  ignored by: git exclude
acceptance: playwright
```
