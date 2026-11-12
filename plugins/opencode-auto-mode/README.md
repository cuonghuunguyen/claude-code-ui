# OpenCode auto mode

A standalone OpenCode plugin that answers `ask` permission prompts for you, using a classifier
model instead of a human. Built against OpenCode 1.19.5 (V1 plugin API).

## Install

Add it to your project's `opencode.json`:

```json
{
  "plugin": [
    ["file:///absolute/path/to/plugins/opencode-auto-mode/auto-mode.ts", { "maxConsecutiveBlocks": 3 }]
  ]
}
```

The file has zero install dependencies (only relative imports and node builtins), so it loads
as-is — no `npm install` in this folder.

Set `OPENCODE_AUTO_MODE=0` in the environment to disable it without touching config.

## Options

| option | default | meaning |
|---|---|---|
| `enabled` | `true` | master on/off switch |
| `model` | the asking session's current model | `"provider/model"` to use a specific classifier model |
| `timeoutMs` | `60000` | classifier call timeout; on timeout, do nothing |
| `maxConsecutiveBlocks` | `3` | consecutive blocks before auto mode stops deciding for a session |
| `maxTotalBlocks` | `20` | total blocks before auto mode stops deciding for a session |
| `allow` | `[]` | extra bullet points appended to the default "allow" section of the policy prompt |
| `softDeny` | `[]` | extra bullet points appended to the default "block" section |
| `environment` | `[]` | project-specific context bullets (no defaults) |
| `replaceDefaults` | `false` | when `true`, `allow`/`softDeny`/`environment` replace the defaults instead of extending them |
| `maxOutputTokens` | `1024` | output cap for the classifier reply (reasoning models may need more; if a model rejects temperature 0 or runs out of tokens, the reply is unparseable and auto mode defers to the human) |
| `transcriptChars` | `60000` | char budget for the transcript sent to the classifier |
| `skipPermissions` | `[]` | permission names never auto-decided (left for the human) |
| `onlyPermissions` | *(unset)* | when set, only these permission names are auto-decided |

## How it works

1. `permission.ask` is dead in 1.19.5 — this plugin listens on the generic `event` hook for
   `permission.asked` instead. Only requests that evaluated to `"ask"` are published; config
   `deny`/`allow` rules already won and never reach here.
2. The `config` hook registers a hidden subagent, `auto-mode-classifier` (`mode: "subagent"`,
   `hidden: true`, `temperature: 0`, `permission: { "*": "deny" }`), whose static `prompt` is the
   policy prompt built from the options above. The `*` deny rule hides every tool (built-in,
   plugin, MCP) from the classifier and denies any call, so an injected instruction cannot make it
   call a tool or spawn a `task` subagent. (A per-agent `tools` map would not work: the hook adds
   the agent after config decode and OpenCode never reads `tools` there.)
3. On a `permission.asked` event, the plugin builds a JSONL transcript of the asking session (user
   text and the *inputs* of assistant tool calls, never assistant text, never tool output) plus a
   final `{"action": ...}` record for the permission under decision, creates a fresh session with no
   `parentID`, prompts the classifier agent with `## Transcript` / `## Action` sections as the user
   message, reads the reply, and always deletes the session afterwards (aborting it first on a
   timeout). Asks of one session are classified one at a time.
4. The classifier replies with `<block>yes|no</block><reason>...</reason>` (optionally preceded by
   `<thinking>...</thinking>`). `yes` means block; `no` means allow. Anything unparseable (no block
   tag, an unclosed `<thinking>`, conflicting block tags), or any error or timeout along the way,
   means **do nothing**: the prompt is left for the human.
5. Replies use OpenCode's V2 route, `POST /permission/{id}/reply`, via the V1 SDK client's raw
   request method (`client._client`, which already carries the server's auth headers). Allow is
   `"once"` (falling back to the V1 route); never `"always"`. A `404` (someone else already
   answered) is swallowed.
6. **Reject cascade.** In OpenCode, rejecting one ask rejects every other pending ask of the same
   session, and a reject *without* a message halts the whole turn (a reject *with* a message lets
   the model continue with that feedback). So a block always sends a message (the reason, else
   "Blocked by auto mode."), never falls back to the message-less V1 route, and is **deferred to the
   human** when the session has other pending asks (or they cannot be listed).
7. Every decision is logged via `client.app.log` (service `"auto-mode"`) with its outcome
   (`replied`, `already-answered`, `failed`, or `deferred`/`none`); only replied blocks count toward
   the limits and toast.

## Limits and known caveats

- **This is a model decision, not a guarantee.** The classifier can be wrong in either direction.
  Treat it as a second pair of eyes, not a security boundary.
- **Prompt injection is not solved.** The policy prompt tells the classifier to treat the
  transcript as data, not instructions, but a sufficiently adversarial tool output or file content
  could still influence its answer. Destructive config-level `deny` rules remain the real backstop
  for anything that must never happen.
- **Data sent to the classifier model**: the session's transcript (user messages and tool-call
  *inputs*, not outputs) and the pending action, plus `AGENTS.md`/`CLAUDE.md` if present. This goes
  to whatever provider/model opencode is configured to use for the classifier, same as any other
  agent call.
- **What the classifier sees besides our prompt.** OpenCode adds its own system prompt parts to
  every agent, the classifier included: the environment block, the project's `AGENTS.md`/`CLAUDE.md`
  instructions, and MCP/skill descriptions. This plugin therefore does not embed those itself. The
  classifier has no tools, but all of that text is sent to the classifier model.
- A reasoning model, or one that rejects `temperature: 0`, may fail or run out of output tokens;
  that just makes auto mode defer to the human.
- Denial limits are per-session and in-memory: they reset when the server restarts.
