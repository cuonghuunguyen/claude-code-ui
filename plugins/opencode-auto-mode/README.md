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
| `includeAgentsMd` | `true` | include the project's `AGENTS.md`/`CLAUDE.md` in the policy prompt |
| `transcriptChars` | `60000` | char budget for the transcript sent to the classifier |
| `skipPermissions` | `[]` | permission names never auto-decided (left for the human) |
| `onlyPermissions` | *(unset)* | when set, only these permission names are auto-decided |

## How it works

1. `permission.ask` is dead in 1.19.5 — this plugin listens on the generic `event` hook for
   `permission.asked` instead. Only requests that evaluated to `"ask"` are published; config
   `deny`/`allow` rules already won and never reach here.
2. The `config` hook registers a hidden subagent, `auto-mode-classifier` (`mode: "subagent"`,
   `hidden: true`, `temperature: 0`, deny-all permission, built-in tools turned off), whose static
   `prompt` is the policy prompt built from the options above plus `AGENTS.md`/`CLAUDE.md`.
3. On a `permission.asked` event, the plugin builds a JSONL transcript of the asking session (user
   text and the *inputs* of assistant tool calls — never assistant text, never tool output) plus a
   final `{"action": …}` record for the permission under decision, creates a fresh session with no
   `parentID` (so it isn't a child of the asking session), prompts the classifier agent with that
   transcript as the user message, reads the reply, and always deletes the session afterwards.
4. The classifier replies with `<block>yes|no</block><reason>…</reason>` (optionally preceded by
   `<thinking>…</thinking>`). `yes` means block; `no` means allow. Anything unparseable, or any
   error or timeout along the way, means **do nothing** — the prompt is left for the human.
5. A reply is sent with OpenCode's V2 route, `POST /permission/{id}/reply`, via the V1 SDK
   client's underlying raw request method (`client._client`, which already carries the server's
   auth headers), falling back to the V1 route if that fails. Never `"always"` — only `"once"` or
   `"reject"`. A `404` (someone else, e.g. the claude-ui card or the TUI, already answered) is
   swallowed.
6. Every decision is logged via `client.app.log` (service `"auto-mode"`); a block, and hitting a
   denial limit, also shows a toast via `client.tui.showToast`.

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
- **Disabling tools for the classifier agent is best-effort.** OpenCode 1.19.5's per-agent `tools`
  map has no wildcard; it only matches exact tool ids. This plugin lists the tool ids built into
  1.19.5 (`bash`, `edit`, `read`, …) and turns them off, but a plugin-registered or MCP tool is not
  covered. The deny-all permission ruleset (`edit`/`bash`/`webfetch`/`doom_loop`/
  `external_directory`) is the real backstop for the risky categories.
- Denial limits are per-session and in-memory: they reset when the server restarts.
