---
description: How claude-code-ui compares with the Claude Code CLI, Anthropic's own apps and other community UIs for Claude Code (CloudCLI / claudecodeui, opcode, claude-code-webui), and when to pick which.
---

# How it compares

claude-code-ui is one of several ways to use Claude Code outside a plain terminal. This page says what sets it apart, so you can pick the right one. Details of other projects are taken from their own pages; check them for the current state.

## In one sentence

claude-code-ui is a **local daemon plus a web app**: Claude Code runs on your own computer, and you watch and steer many sessions from any browser, including your phone, with no cloud service in between.

## Compared with the Claude Code CLI

The CLI and claude-code-ui run the same Claude Code and share the same history in `~/.claude`, so you can switch between them per session.

| | `claude` CLI | claude-code-ui |
| --- | --- | --- |
| Where you use it | One terminal per session | Any browser, many sessions in tabs |
| From a phone | Needs SSH and a terminal app | Built in (`--tailscale`), installs as an app, push notifications |
| Sessions after you close the window | End with the terminal | Keep running in the daemon |
| Waiting requests across sessions | Check each terminal | One [Focus page](../features/focus) |
| Files, diffs, git graph | Separate tools | Panels next to the chat |
| Install | `npm i -g @anthropic-ai/claude-code` | `npx claude-code-ui` (uses your logged-in Claude Code) |

## Compared with Anthropic's own apps

Anthropic ships Claude Code as a CLI, IDE extensions, a desktop app and Claude Code on the web. Claude Code on the web runs sessions in Anthropic's cloud. claude-code-ui instead runs every session on your own machine, against your local files, tools and credentials, and only you can reach it. It is an unofficial community project.

## Compared with other community UIs

| Project | What it is | License | Package / command |
| --- | --- | --- | --- |
| **claude-code-ui** (this one) | Local daemon + web app; many sessions, phone, worktrees, orchestration, WSL and Docker sides | MIT | npm `claude-code-ui`, command `claude-ui` |
| [CloudCLI](https://github.com/siteboon/claudecodeui) (also called "Claude Code UI", repo `claudecodeui`) | Web and mobile UI for Claude Code and other coding CLIs (OpenCode, Cursor CLI, Codex) | AGPL-3.0 | see its README |
| [opcode](https://github.com/winfunc/opcode) (formerly Claudia) | Desktop GUI app and toolkit for Claude Code | AGPL-3.0 | desktop app |
| [claude-code-webui](https://github.com/sugyan/claude-code-webui) | Web chat interface for the Claude CLI | MIT | see its README |

The names are close. If you read about "Claude Code UI" elsewhere, check the repository: this project is [cuonghuunguyen/claude-code-ui](https://github.com/cuonghuunguyen/claude-code-ui).

## Pick claude-code-ui when

- You run **several Claude Code sessions at once** and want one place that shows which one needs you.
- You want to **answer Claude from your phone** while the work runs on your computer.
- Your code and credentials must **stay on your machine**: no account, no relay, no telemetry.
- You work on **Windows with WSL** or in **Docker containers** and want one UI for all of them.
- You want **Claude Code's own behavior** (permission prompts, modes, slash commands, skills, `/rewind`) rather than a different agent.

Ready? [Install & first run](install) takes a minute. More answers: [FAQ](faq).
