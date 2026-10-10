# claude-code-ui

[![npm](https://img.shields.io/npm/v/claude-code-ui)](https://www.npmjs.com/package/claude-code-ui)
[![license](https://img.shields.io/npm/l/claude-code-ui)](https://github.com/cuonghuunguyen/claude-code-ui/blob/main/LICENSE)
[![docs](https://img.shields.io/badge/docs-cuonghuunguyen.github.io-blue)](https://cuonghuunguyen.github.io/claude-code-ui/)

A web UI for Claude Code. Run, watch and steer many sessions from your browser or phone. A small local daemon runs everything on your own machine: no cloud, no relay, no telemetry. Unofficial; not affiliated with Anthropic.

**Docs: https://cuonghuunguyen.github.io/claude-code-ui/**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/cuonghuunguyen/claude-code-ui/main/docs/site/public/screenshots/workspace-dark.png">
  <img alt="claude-code-ui: projects and sessions on the left, a session in the middle, the changes panel on the right" src="https://raw.githubusercontent.com/cuonghuunguyen/claude-code-ui/main/docs/site/public/screenshots/workspace-light.png">
</picture>

## Install

You need Node.js 22+ and Claude Code logged in (`claude login`; your subscription is used, no API key). On Linux and WSL also a C++ toolchain for the terminal panel (`sudo apt install build-essential python3`).

```sh
npx claude-code-ui            # run without installing
npm i -g claude-code-ui       # or install; the command is `claude-ui`
claude-ui
```

It prints a pairing link and a QR code. Open the link to use the app. To use it from your phone, start it with `claude-ui --tailscale`.

## What you get

- Sessions in tabs, grouped by project. They keep running when the browser closes.
- Same behavior as Claude Code: permission prompts, modes, models, slash commands, skills, `/rewind`. Sessions from the `claude` CLI show up too.
- A Focus page and notifications for everything that waits for you.
- File tree and editor, diffs, a git graph and a terminal next to the chat.
- Works on a phone and installs as an app (over HTTPS).
- Windows with WSL, and Docker containers, from one install.

Read more:
[Install & first run](https://cuonghuunguyen.github.io/claude-code-ui/guide/install) ·
[Quick tour](https://cuonghuunguyen.github.io/claude-code-ui/guide/tour) ·
[Keyboard shortcuts](https://cuonghuunguyen.github.io/claude-code-ui/reference/shortcuts) ·
[CLI flags](https://cuonghuunguyen.github.io/claude-code-ui/reference/cli) ·
[Troubleshooting](https://cuonghuunguyen.github.io/claude-code-ui/reference/troubleshooting) ·
[Privacy](https://cuonghuunguyen.github.io/claude-code-ui/reference/privacy)

## Security in one paragraph

The daemon can run any command on your machine, so treat access to it like shell access. It listens on `127.0.0.1` only (unless `--lan`), every connection needs the pairing token, sessions stay inside `--roots`, and permission prompts are on by default. Keep the pairing link private. Details: [Privacy](https://cuonghuunguyen.github.io/claude-code-ui/reference/privacy).

## Contributing

Build from source, project layout, tests and release steps: [CONTRIBUTING.md](https://github.com/cuonghuunguyen/claude-code-ui/blob/main/CONTRIBUTING.md). Changes: [CHANGELOG.md](https://github.com/cuonghuunguyen/claude-code-ui/blob/main/CHANGELOG.md).

## License

[MIT](https://github.com/cuonghuunguyen/claude-code-ui/blob/main/LICENSE). Bundled third-party licenses: [THIRD_PARTY_NOTICES.md](https://github.com/cuonghuunguyen/claude-code-ui/blob/main/THIRD_PARTY_NOTICES.md).
