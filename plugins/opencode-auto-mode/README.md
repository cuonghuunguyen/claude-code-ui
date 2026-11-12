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
| `log` | `true` | write the local decision log (see below); `false` turns it off |
| `logDir` | OpenCode's data dir | where the log lives: `<logDir>/auto-mode/decisions.jsonl` |
| `logMaxBytes` | `20971520` (20 MB) | past this size the log is renamed to `decisions.1.jsonl`, replacing the previous one |

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
7. Every decision is also appended to the local decision log (below).
8. Every decision is logged via `client.app.log` (service `"auto-mode"`) with its outcome
   (`replied`, `already-answered`, `failed`, or `deferred`/`none`); only replied blocks count toward
   the limits and toast.

## Decision log

On by default. Every decision is appended, one JSON object per line, to
`<data dir>/auto-mode/decisions.jsonl`. The data dir is `logDir` if set, else what OpenCode itself
uses (`$XDG_DATA_HOME/opencode`, falling back to `~/.local/share/opencode` on Linux, macOS and
Windows alike: `opencode debug paths` shows it). It is never inside your project. The file is
created with mode `0600` (best effort on Windows) and rotated once to `decisions.1.jsonl` past
`logMaxBytes`.

- `{"v":1,"kind":"decision", at, requestID, sessionID, project, permission, patterns, model,
  policyHash, verdict, reason, outcome, ms, input}`. `verdict` is `allow`, `block` or `none` (what
  the classifier said; a block deferred to the human keeps `block`). `outcome` is `replied`,
  `already-answered`, `failed`, `deferred`, `skipped` (session limit, or already answered),
  `timeout` or `none`. `project` is the git worktree (the directory when there is none).
  `input` is the exact `{transcript, action}` sent to the classifier, so the decision can be replayed.
- `{"v":1,"kind":"label", at, requestID, reply}`: written when the human answers an ask the plugin
  did not answer itself (`permission.replied` carries `requestID` and `reply`: `once`, `always` or
  `reject`). That answer is the ground truth the commands below use. Caveat: when you reject one
  ask, OpenCode also rejects the session's other pending asks, and those are labeled `reject` too.

**The log can contain secrets and source code** from your sessions (user messages and tool-call
inputs). It stays on your machine. It is only ever sent to the classifier model (by
`/auto-mode-eval`, as replays) and to your session model (by `/auto-mode-improve`, as a compact
report of overrides); nowhere else. A write failure is reported once through the OpenCode log and
never affects a decision.

Turn it off with `"log": false`. Delete it by removing `<data dir>/auto-mode/` (both files).

## Slash commands

Both are registered by the plugin (config hook + two plugin tools, `auto_mode_eval` and
`auto_mode_improve`; the classifier agent denies all tools, so it never sees them). Both read the
one global log and take a scope: `project` (default: records whose `project` is the current
worktree) or `all` (every project), e.g. `/auto-mode-eval 100 all-projects`.

- `/auto-mode-eval [limit] [all] [all-projects] [model=provider/model]` replays the most recent
  decisions that have a logged input through the classifier **with the current policy**, at most 3
  at a time, and reports counts, agreement, a confusion matrix (expected allow/block against got
  allow/block/none) and the disagreements. By default (`labeled`) the truth is your answer
  (`once`/`always` = allow, `reject` = block); with `all` the previous verdict is the reference (a
  regression check). Default 50 cases, max 500. **It calls the model once per case**, so it costs
  tokens. Replays are not written to the log.
- `/auto-mode-improve [limit] [all-projects]` makes no model call itself. It returns the effective
  rules, the current policy prompt, which config file appears to supply the options (or "unknown"),
  and the cases where you overrode the classifier or decided what it left to you. The session model
  then proposes `allow`/`softDeny`/`environment` changes as an `opencode.json` snippet, split into
  project-specific (this project's config), personal (`~/.config/opencode/opencode.json`) and
  candidates for the plugin's shipped defaults (reported only), explains which examples each fixes,
  warns about over-allowing rules, and edits no files. Run `/auto-mode-eval` after applying them.

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
  every agent, the classifier included: the environment block and the project's
  `AGENTS.md`/`CLAUDE.md` instructions. Skills are suppressed for an agent without tools, and MCP
  instructions only survive for servers that list no tools. This plugin therefore does not embed
  `AGENTS.md` itself. The classifier has no tools, but that text is sent to the classifier model.
- **Reject race.** There is a small window between the pending-ask check and the reject: a sibling
  ask arriving in between is cascade-rejected without a message, which halts the turn.
- Each ask's decision has a hard deadline (`timeoutMs` + 10 s) so a hung call cannot block later
  asks of the session; asks already answered while queued are skipped.
- A reasoning model, or one that rejects `temperature: 0`, may fail or run out of output tokens;
  that just makes auto mode defer to the human.
- Denial limits are per-session and in-memory: they reset when the server restarts.
