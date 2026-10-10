# Privacy

**Short version:** everything stays on your machine. There is no claude-code-ui server, no account and no telemetry.

## What stays local

- **The daemon and the web app** run on your computer. Nothing is hosted elsewhere.
- **Session history** is Claude Code's own transcript files in `~/.claude/projects/`. claude-code-ui keeps no database of its own.
- **Its own data** (pairing token, project list, settings) is in the [config folder](cli#files).
- **Your Claude login** stays in the daemon. It is never sent to the browser.

## What leaves your machine

| What | Where to | Why |
| --- | --- | --- |
| Your prompts and code context | Anthropic | That is how Claude works, same as the `claude` CLI |
| "What is the latest version?" | npm (`registry.npmjs.org`) | The [update check](../features/updates). Nothing about you is sent. Off with `--no-update-check`. |
| Push notifications | Your browser's push service (Google, Apple, Mozilla) | Only if you turn push on. End-to-end encrypted: the push service cannot read them. |

## Remote access

- By default the daemon listens on `127.0.0.1` only: nobody else can reach it.
- For your phone, use Tailscale: private to your own devices, with HTTPS. The public Tailscale Funnel is never used.
- `--lan` is plain HTTP. Use it only on a network you trust.

## Access control

- Every connection needs the pairing token. Keep the pairing link private: it gives full access.
- **The daemon can run any command on your computer.** Treat access to it like shell access.
- Sessions, files and terminals stay inside the allowed roots (`--roots`).
- Permission prompts are on by default. "Bypass permissions" is hidden unless you start with `--allow-bypass`.
- To unpair every browser, delete the `token` file in the config folder and restart.

## Login

claude-code-ui uses your Claude subscription login (`claude login`), not an API key. It is a personal tool: one user, on their own machine, with their own subscription.

Design decisions: [docs/adr](https://github.com/cuonghuunguyen/claude-code-ui/tree/main/docs/adr).
