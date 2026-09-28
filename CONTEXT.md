# Claude Code Web UI

A browser UI that drives Claude Agent SDK sessions running in a local daemon. Full spec: `docs/spec.md`.

## Language

**Daemon**:
The local process that owns all sessions, runs the SDK, and serves browsers over WebSocket. Single source of truth.
_Avoid_: server, backend

**Session**:
One SDK `query()` run in one working directory, keyed by the SDK session ID.
_Avoid_: chat, conversation, thread

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

**Scope**:
How far a permission decision applies: `once` or `session`.

**Tool card**:
The UI rendering of a `tool_call` merged with its `tool_result`, grouped by `toolUseId`.
