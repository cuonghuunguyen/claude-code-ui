---
description: Short answers about claude-code-ui, the open-source web UI for Claude Code. What it is, what it needs, phone use, parallel sessions, cost, privacy and how it differs from similarly named projects.
faq: true
---

# FAQ

Short answers to the questions people ask most about claude-code-ui. For error messages, see [Troubleshooting](../reference/troubleshooting).

## About it

### Is there a web UI or GUI for Claude Code?

Yes. claude-code-ui is a free, open-source (MIT) web UI for Claude Code. Run `npx claude-code-ui`, open the link it prints, and you use Claude Code in your browser: sessions in tabs, permission prompts as buttons, file tree, diffs, a git graph and a terminal next to the chat. It runs on your own machine. It is unofficial and not affiliated with Anthropic.

### What exactly is claude-code-ui?

A small local server (the daemon) plus a web app. The daemon runs Claude Code sessions with the Claude Agent SDK on your computer. The web app, opened in any browser, shows and steers them. The npm package is `claude-code-ui` and the command is `claude-ui`.

### Is it the same project as CloudCLI ("Claude Code UI") or claudecodeui?

No. Those are separate projects with similar names. This one is [cuonghuunguyen/claude-code-ui](https://github.com/cuonghuunguyen/claude-code-ui), published on npm as `claude-code-ui`, with the command `claude-ui`. See [How it compares](compare).

### Is it free?

Yes. claude-code-ui is MIT licensed and has no paid tier. Claude itself is used through your own Claude subscription, as with the `claude` CLI.

## Setup

### What do I need to run it?

Node.js 22 or newer and Claude Code logged in (`claude login`). On Linux and WSL also a C++ toolchain for the terminal panel (`sudo apt install build-essential python3`). Then run `npx claude-code-ui`. See [Install & first run](install).

### Does it need an Anthropic API key?

No. It uses your Claude subscription login from `claude login`, not an API key.

### Which operating systems does it support?

Windows, macOS and Linux. On Windows, one install can also run sessions inside WSL distros, and on any system inside running Docker containers. See [WSL & Docker](../features/wsl-docker).

### Does it work with sessions I started in the `claude` CLI or VS Code?

Yes. Both read and write the same history in `~/.claude`. A session started in the CLI or the VS Code extension shows up in claude-code-ui, and the other way round.

## Using it

### Can I use Claude Code from my phone?

Yes. Start the daemon with `claude-ui --tailscale` and scan the QR code it prints with your phone. You get an HTTPS link that only your own devices can reach, the app installs on the Home Screen, and push notifications tell you when a session needs you. See [Phone & remote access](../features/remote-access).

### Can I run many Claude Code sessions in parallel?

Yes. Each session is a tab, grouped by project, and they all run at the same time in the daemon. Give each its own git worktree so they do not touch the same checkout. The [Focus page](../features/focus) lists every session that waits for an answer, across all projects. See [Projects & worktrees](../features/projects).

### Do sessions keep running when I close the browser?

Yes. Sessions run in the daemon, not in the page. Close the tab, reopen it later and catch up. Stopping the daemon stops the running turn; the session and its history stay.

### Can one Claude Code session start and steer others?

Yes, with orchestration turned on. A coordinator session starts worker sessions, each in its own worktree if you ask, and their questions and permission requests come to you. See [Orchestration](../features/orchestration).

### Does it support permission prompts, slash commands, skills and MCP servers?

Yes. It behaves like Claude Code: the same permission prompts and modes, models, slash commands, skills, plugins, MCP servers and `/rewind`. See [Permissions & modes](../features/permissions) and [MCP, skills & plugins](../features/config-dialogs).

## Privacy and security

### Does my code go through a third-party server?

No. There is no claude-code-ui server, account or telemetry. Your prompts go to Anthropic, the same as with the `claude` CLI. The only other call is a version check to npm, which you can turn off with `--no-update-check`. See [Privacy](../reference/privacy).

### Is it safe to expose it on the network?

Treat access to the daemon like shell access to your computer. By default it listens on `127.0.0.1` only, every browser needs the pairing token, sessions stay inside `--roots`, and permission prompts are on. For a phone, use `--tailscale` rather than opening a port to the internet.
