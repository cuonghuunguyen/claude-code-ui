# SDK transcript is the only store; no database of our own

The Agent SDK already writes every session to `~/.claude/projects/<encoded-cwd>/<id>.jsonl` and exposes `listSessions()` / `getSessionMessages()`. The daemon therefore keeps no SQLite or event log on disk: the session list and history are rebuilt from the transcript, and only the live event log is held in memory. OpenCode has a database because it runs its own agent loop; we do not.

## Consequences

- After a daemon restart, past turns lose their cost/duration footer and their permission history (the transcript does not contain them).
- `seq` restarts from 1 after a daemon restart; clients detect this through a `logEpoch` and replay from scratch.
- Sessions started in the terminal CLI appear in the list too (same transcripts).
- Add a database only when data appears that has no home in the transcript. First case: each session's model, permission mode and effort (`sessions.json` in the config dir); the transcript records mode and effort only per prompt, not a change after the last prompt.
