# Delivery — push, watch the build, open the PR, start the review

Stages 3 to 5. Workers commit and stop; **the coordinator delivers**, so one place decides
what reaches the remote and the batch has one answer to "which of these is deliverable". A
worker that pushes on its own initiative takes that away.

Push only after stage 2 is green. The playbook's `push` decides how:

| `push` | Do |
|---|---|
| `coordinator` | Push as below. |
| `ask` | Ask the user in chat, per ticket or once for the batch, before the first push. |
| `never` | Stop delivery at the local commit. Stage 5 reviews the local branch against base. |

---

## 1. Push with a renaming refspec

The worktree branch cannot contain `/`; the host convention often does. The playbook's
`remote-branch` gives the remote name.

```bash
git -C <worktree> push --dry-run origin <branch>:refs/heads/<remote-branch>   # always first
git -C <worktree> push           origin <branch>:refs/heads/<remote-branch>
```

Never force-push. A rejected push is something to report, not to retry harder.

---

## 2. Watch the build

`ci: none` skips this. Otherwise start the build-watch worker (`worker-specs.md` §3) with the
CI adapter's watch instructions pasted into its method.

- **Green → open the PR.**
- **Red →** the excerpt is in `build-<n>.log`; send it to the implementer as a fix message,
  then push again and start a fresh build watch.
- Queued-and-not-started is not a failure.
- Never re-trigger a build without a change in between. A re-trigger is a coin flip you will
  mistake for a fix.
- **Do not open the PR on a red build.**

---

## 3. Open the PR

`host: none` skips this. Otherwise use the host adapter's "open PR" call.

**Write the title yourself**: `<KEY>: <what it does, imperative>`, the same sentence as the
commit subject. Left out, hosts derive one from the branch name, which reads as noise.

The description is the reviewer's entry point:

- what the change does;
- what a reviewer should check;
- what was deliberately left undone;
- that acceptance passed with N cases, and where the report sits.

Do not paste the ticket in: the tracker is the spec and a copy drifts.

**The description is authored once, at creation.** Commenting on the PR afterwards is
forbidden (`SKILL.md` §3). Anything said later goes in the report to the user.

**Stacked branches: say so, do not tidy.** A PR based on a sibling branch carries the
sibling's commits until it lands. Note it in the description. Do not rebase, squash or
retarget to make it look clean.

Then transition the ticket to the playbook's `in-review` state. Trackers that refuse skipped
states need `implemented` first (it should already have happened at stage 2).

---

## 4. Start the review

Stage 5, `worker-specs.md` §4. The rules that get forgotten:

1. **Fresh agent, mandatory.** An agent reviewing its own diff is worthless. Fresh agent, not
   a fresh checkout: the implementer's worktree, read-only.
2. **`pr-review` for every PR regardless of size**, all phases.
3. **Findings go in the report, never on the PR.** The user decides what reaches the host.
