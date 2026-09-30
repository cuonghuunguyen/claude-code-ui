# Claude Code Web UI

A browser UI that drives Claude Agent SDK sessions running in a local daemon. Full spec: `docs/spec.md`.

## Language

**Daemon**:
The local process that owns all sessions, runs the SDK, and serves browsers over WebSocket. Single source of truth.
_Avoid_: server, backend

**Session**:
One SDK session in one working directory, identified by its session ID. The SDK transcript is its durable history. It may be driven by several `query()` runs over time (e.g. resumed after a daemon restart).
_Avoid_: chat, conversation, thread

**Turn**:
One user prompt and everything it causes, ending with a turn result or an interrupt. Waiting for a permission request is part of the running turn.
_Avoid_: exchange, round

**Event**:
One entry in a session's event log, carrying a `seq` and one part.
_Avoid_: message (on the wire)

**Seq**:
Per-session, monotonically increasing event number used for replay and de-duplication.

**Part**:
One unit of the normalized message model (`assistant_text`, `tool_call`, `permission_request`, ...). The UI renders only parts.
_Avoid_: block, chunk

**Adapter**:
Shared-package code that converts raw SDK messages into parts.

**Permission request**:
A pending `canUseTool` decision waiting for a browser answer; settled by the first `permission.respond`.
_Avoid_: approval, prompt (prompt = user turn text)

**Question**:
A multiple-choice question Claude asks the user mid-turn (`AskUserQuestion`); pending until answered, like a permission request.
_Avoid_: prompt, dialog

**Needs input**:
Session condition where a permission request or question is pending. Triggers a push notification.

**Permission rule**:
A saved "don't ask again" decision (e.g. `Bash(npm run test *)`), suggested by the SDK and chosen by the user in a permission request. Same rules as Claude Code, shared with it.
_Avoid_: scope, allow-list entry

**Steering**:
Sending a user message while a turn runs; it is injected into the running turn instead of waiting for the turn to end.
_Avoid_: queueing (different behavior)

**Checkpoint**:
The file state saved before a user prompt's turn edits files; one per user prompt. Covers Edit/Write changes only, not Bash.

**Rewind**:
Returning a session to a checkpoint: code only, conversation only, or both. Same modes as Claude Code's `/rewind`.
_Avoid_: undo, revert

**Tool card**:
The UI rendering of a `tool_call` merged with its `tool_result`, grouped by `toolUseId`.
