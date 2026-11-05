# Local history is a store of our own in the config dir

Rollback of a hunk runs without confirmation (IntelliJ behaviour). In IntelliJ and VS Code the undo for that, and for overwritten saves, is Local history. Lost file content has no home in the SDK transcript: the transcript keeps tool calls, not the content a git write or an editor save replaced, and Claude Code's `~/.claude/file-history/` covers only agent edits for rewind, in a format we do not own. So, as the second exception to ADR 0001, the daemon keeps Local history in `<config dir>/history/`: a snapshot on a Files-tab save, on an agent Edit/Write (from the content the daemon already holds), and before every claude-ui git write that loses content (Rollback, Smart checkout, reset --hard, stash drop). Limits follow VS Code: 50 entries per file, files over 256 KB skipped, changes within 10 s merged into one entry, exclude globs.

## Considered options

- **No local history, confirm every rollback**: safe, but slower than IntelliJ and leaves editor saves unrecoverable.
- **Git objects** (`git hash-object -w` plus refs under `refs/claude-ui/`): lives with the repository, but writes into the user's repository, shows in tools that list refs, and gc rules apply.
- **Reuse Claude Code file-history**: covers agent edits only; its format is internal to Claude Code and may change.
- **Config dir store** (chosen): ours, outside the repository, pruned by VS Code's caps.

## Consequences

- Writing entries never blocks a turn: snapshots queue in the background and are dropped under load, so an entry can be missing.
- History is per daemon machine; a repository opened from another machine has none.
- Agent-edit entries duplicate part of Claude Code's file-history on disk.
