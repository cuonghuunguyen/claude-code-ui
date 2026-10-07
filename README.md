# claude-code-ui

[![npm](https://img.shields.io/npm/v/claude-code-ui)](https://www.npmjs.com/package/claude-code-ui)
[![license](https://img.shields.io/npm/l/claude-code-ui)](LICENSE)

A browser UI for Claude Code sessions, run by a local daemon on your own machine. Start, watch and steer agent sessions from any browser, including your phone. Unofficial; not affiliated with Anthropic.

```sh
npx claude-code-ui
```

It prints a pairing URL and a QR code. Open the URL (or scan the QR) to use the app.

## Features

- **Sessions**: start, resume and steer Claude Code sessions in any allowed folder. Sessions keep running when the browser disconnects; reconnecting catches up without losing or duplicating messages.
- **Same behavior as Claude Code**: permission prompts with the same options, questions, permission modes (incl. Auto), models, effort, slash commands and skills, checkpoints and `/rewind`.
- **Readable tool activity**: bash output, file-edit diffs, todo lists, subagent view.
- **Shared with the terminal**: sessions started in the `claude` CLI or the VS Code extension show up, and the other way round.
- **Workspace**: file tree, editor, changes tab, terminal panel.
- **Config dialogs**: MCP servers, skills, plugins.
- **Push notifications** when Claude needs input or finishes (HTTPS needed; iOS 16.4+ with the app on the Home Screen); without HTTPS the daemon's machine shows a desktop notification (Linux `notify-send`, macOS, Windows toast).
- **Windows + WSL, Docker**: one install also runs sessions in your WSL distros and in running Docker containers.
- **Private**: no hosting, no cloud relay. The daemon listens on `127.0.0.1` only unless `--lan`; every connection needs the pairing token.

## Requirements

- Node.js 22+
- Claude Code logged in: `claude login` (your subscription is used; no API key needed). `ANTHROPIC_API_KEY` also works.
- Linux and WSL only: a C++ toolchain to compile `node-pty` (terminal panel). Debian/Ubuntu: `sudo apt install build-essential python3`. Windows and macOS use prebuilds.

## Install

```sh
npx claude-code-ui            # run without installing
npm i -g claude-code-ui       # or install; the command is `claude-ui`
claude-ui
```

## Usage

```sh
claude-ui --port 5000 --roots ~/work:~/oss
```

| Flag | Environment variable | Default | Description |
| --- | --- | --- | --- |
| `--port <n>` | `PORT` | `4280` | Port |
| `--roots <paths>` | `CLAUDE_UI_ROOTS` | home directory | Folders sessions, files and terminals may use. Separated like `PATH` (`:`, Windows `;`) |
| `--tailscale` | `CLAUDE_UI_TAILSCALE=1` | off | Serve on your tailnet with `tailscale serve` and print the https link (see [Other devices](#other-devices)) |
| `--hostname <name>` | `CLAUDE_UI_HOSTNAME` | | HTTPS name of a proxy in front of the daemon (see [Other devices](#other-devices)) |
| `--lan` | `CLAUDE_UI_LAN=1` | off | Also listen on the local network, plain HTTP (see [Other devices](#other-devices)) |
| `--allow-bypass` | `CLAUDE_UI_ALLOW_BYPASS=1` | off | Offer the "Bypass permissions" mode |
| `--no-update-check` | `CLAUDE_UI_UPDATE_CHECK=0` | check on | Do not check npm for a newer version (see [Update](#update)) |
| `--no-os-notify` | `CLAUDE_UI_OS_NOTIFY=0` | on | No desktop notification on the daemon's machine (see [Other devices](#other-devices)) |
| `-v, --version` | | | Print the version |
| `-h, --help` | | | Print the help |

A flag overrides its environment variable.

Environment only: `CLAUDE_UI_IDLE_CLOSE_MINUTES` (default `10`) closes the Claude process of an idle session no tab shows after this many minutes (`0`: never). The session stays in the list; the next prompt resumes it.

Config (pairing token, push keys, saved state): `$XDG_CONFIG_HOME/claude-ui`, else `~/.config/claude-ui`; Windows: `%APPDATA%\claude-ui`.

## Update

claude-ui checks npm for a newer version at start and once a day. When one exists, the app shows **Update available**: **Update and restart** installs it and restarts claude-ui once no session is working (**Restart now** does not wait; it ends running turns and closes terminals). Sessions come back after the restart; the page reconnects by itself. **Not yet** hides the notice until the next version.

From a terminal: `claude-ui update` installs the latest version; the next start runs it.

Updates install into `versions/` of the config folder (no global install, no sudo; works with `npx` too). `npm i -g claude-code-ui@latest` keeps working. A source checkout does not update.

If a new version does not start, claude-ui starts the previous one and says so. To try the new version again, or to get rid of a version that misbehaves later, delete its folder `versions/<version>` in the config folder and restart claude-ui.

A registry mirror: `CLAUDE_UI_UPDATE_REGISTRY=https://npm.example.com` (https; plain http only on localhost) is used for the check and the install.

## Other devices

By default the daemon listens on `127.0.0.1` only. Options: an HTTPS proxy in front of it (its name goes to `--hostname`), or `--lan`. Push notifications on phones need HTTPS.

**Tailscale (recommended)**: works from anywhere, only your devices can reach it.

```sh
claude-ui --tailscale    # checks Tailscale, runs tailscale serve, prints https://<machine>.<tailnet>.ts.net/#token=... + QR
```

Needs Tailscale installed and logged in, with MagicDNS and HTTPS certificates on (admin console, DNS page); claude-ui says what is missing and exits. On Linux without root, run `sudo tailscale set --operator=$USER` once. claude-ui runs `tailscale serve` as a child and stops it on exit; nothing stays configured. Tailscale Funnel (public internet) is refused. If `tailscale serve --bg 4280` is already configured, claude-ui reuses it. Manual alternative: `tailscale serve --bg 4280` and `claude-ui --hostname <machine>.<tailnet>.ts.net`. Windows with WSL: run `--tailscale` on Windows (Windows Tailscale), not inside WSL.

**LAN**: `--lan` also listens on the local network over plain HTTP and prints a pairing URL per LAN address:

```sh
claude-ui --lan    # Pair a browser: open http://192.168.1.20:4280/#token=...
```

Plain HTTP has limits: anyone on the network can read the token, so use it only on a network you trust. Browser push notifications and Copy buttons need HTTPS; while no browser is subscribed, the daemon's machine shows a desktop notification (Linux needs `notify-send`, package `libnotify-bin`). Restart after the machine gets a new LAN address. WSL2 is not reachable from the LAN by default: run it on Windows, or turn on WSL mirrored networking.

For HTTPS on the LAN, put an HTTPS reverse proxy that keeps the `Host` header in front (e.g. [Caddy](https://caddyserver.com): `caddy reverse-proxy --from <machine>.local --to 127.0.0.1:4280`; trust Caddy's local CA on the phone) and start with `--hostname <machine>.local`.

## Windows

Runs natively in PowerShell; no compiler needed.

- `--roots` separates folders with `;`. Default root: `%USERPROFILE%`.
- Terminal panel shell: `SHELL` when it names a Windows file, else `pwsh`, else Windows PowerShell, else `%COMSPEC%`. For Git Bash set `SHELL` to `C:\Program Files\Git\bin\bash.exe`.

### Docker containers

On any OS with the `docker` CLI, one claude-code-ui reaches the Claude install of each running Linux container too.

- **Open project** lists running Linux containers as `Docker: <name>`. The first pick copies claude-ui into the container (`~/.local/share/claude-ui/side`) and starts it with `docker exec`.
- The container needs Node.js 22+, make/python3/g++ (to build `node-pty`; the `node:22` image has them), network access to npm, and a Claude login: copy `~/.claude/.credentials.json` in, run `claude login` in it, or set `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`. If one is missing, the dialog says what to do.
- You can browse folders under the container's home and the image's WORKDIR; set `CLAUDE_UI_ROOTS` in the container to change that.
- It starts again with claude-ui while the container runs. Without Docker or while its engine is stopped, nothing changes.

### Windows with WSL

The Windows and the WSL Claude CLI are two installs, each with its own `~/.claude`. claude-code-ui on Windows reaches both: one install, one URL, one pairing.

- Install and start it on Windows only. It finds your WSL distros (Docker and Rancher Desktop distros are skipped).
- **Open project** offers `Windows` or `WSL: <distro>`. On the first pick of a distro, it installs itself inside the distro (into `~/.local/share/claude-ui/side`) and starts there. The distro needs Node.js 22+ and a Claude login; if one is missing, the dialog says what to run.
- Projects and sessions of all sides share one sidebar with a side badge. A WSL session runs the WSL Claude, opens a WSL terminal and shows the WSL config.
- A typed path picks its side: `C:\...` Windows, `/home/...` WSL, `\\wsl.localhost\<distro>\...` that distro.

## Security

The daemon can run any shell command: treat access to it as shell access to your machine.

- Listens on `127.0.0.1` only, unless `--lan`; WebSocket connections need the pairing token and pass an origin check.
- Sessions, files and terminals stay inside `--roots`.
- Permission prompts are on by default; "Bypass permissions" is hidden unless `--allow-bypass`.
- Your Claude login stays in the daemon; it is never sent to the browser.
- The update check is a GET of `registry.npmjs.org/claude-code-ui/latest`; nothing about you or your sessions is sent. Off: `--no-update-check`.
- Keep the pairing URL private. To revoke all paired browsers, delete `token` in the config folder and restart.

## Troubleshooting

- **`npm i` fails on `node-pty`** (Linux, WSL): install the C++ toolchain, see [Requirements](#requirements).
- **The browser keeps asking to pair**: open the pairing URL the daemon prints at start.
- **Port in use**: `claude-ui --port 4281`.

## Contributing

Build from source, project layout, tests and release steps: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). Bundled third-party licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
