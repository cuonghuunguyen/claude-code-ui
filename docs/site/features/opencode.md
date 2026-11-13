# OpenCode engine

A session can run on [OpenCode](https://opencode.ai) instead of Claude. The prompt box, timeline, permissions, Rewind and the rest of the app work the same way.

![The new-session tab with the OpenCode engine and its model picker open](/screenshots/opencode.png)

## How to use

1. Install OpenCode (version 1.18.0 or newer) so that `opencode` is on the PATH of the daemon's computer. Otherwise set the path in [Settings › OpenCode](../reference/settings#opencode).
2. In the new-session tab, pick **OpenCode** in the **Engine** chip, the first chip of the row. The engine cannot change afterwards. Sidebar rows and the session header show an OpenCode tag.
3. Connect a provider: Settings › OpenCode › **Providers** › **Connect**, then an API key, or the login page of the provider in your browser. OpenCode's free models work without a provider.
4. Pick a model in the model picker. It lists every model OpenCode can run, grouped by provider. From 8 models it has a search field (name, id, provider). If the list fails, the footer says so and offers **Retry**. **Connect a provider…** in the footer opens Settings.
5. Pick an **agent** (Build, Plan or a custom agent of your OpenCode config) in the chooser next to the permission chooser. <kbd>Shift</kbd>+<kbd>Tab</kbd> cycles the agents.
6. Pick a permission mode. **Use OpenCode config** is the default: the OpenCode defaults, the `permission` section of `opencode.json` and the agent decide, and claude-ui adds no rules. **Ask before edits**, **Edit automatically** and, when enabled, **Bypass** add claude-ui's rules on top. A custom agent's own denials always win.

## Good to know

- Works as for Claude: prompts, steering a running turn, questions, permission requests, [Rewind](timeline#rewind), [Aside](aside), slash commands (`/compact`, `/undo`, `/redo` and the commands of your OpenCode config), [inline visualizations](visualize) and [orchestration](orchestration). A coordinator and each of its workers pick their own engine.
- Not available: the plan usage ring and the account switcher (they belong to Claude), Reload plugins and background shells. A control that an OpenCode session cannot use is hidden or disabled with the tooltip "Not supported by this session's engine".
- Rewind restores the files and the conversation together; OpenCode has no variant for only one of them. A file change by OpenCode is not in [Local history](timeline#local-history-file-timeline).
- While OpenCode retries a busy or rate-limited model, the end of the turn shows the reason and "Retrying in 12s · attempt 2" in place of Thinking.
- A turn that OpenCode ends on its own shows a warning with the reason.
- OpenCode keeps the history and the provider logins of its sessions; claude-ui keeps neither. The daemon starts one `opencode serve` on the first OpenCode session. It listens on `127.0.0.1` only, behind a random password.
- A [side](wsl-docker) runs its own OpenCode (its PATH, or its own path setting). Settings › OpenCode edits the local daemon only.
- Settings › OpenCode › **Restart OpenCode** is refused while an OpenCode session runs.
