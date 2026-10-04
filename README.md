# claude-ui

Browser UI for Claude Agent SDK sessions run by a local daemon. Spec: `docs/spec.md`. Glossary: `CONTEXT.md`.

## Layout (npm workspaces)

| Package | Path | Content |
| --- | --- | --- |
| `@claude-ui/protocol` | `packages/protocol` | Wire protocol, message model (parts), adapter (SDK messages → parts) |
| `@claude-ui/daemon` | `packages/daemon` | Node daemon: HTTP (web app) + WebSocket `/ws`, sessions via `@anthropic-ai/claude-agent-sdk` |
| `@claude-ui/web` | `packages/web` | React + Vite + Tailwind + shadcn/ui + AI Elements |
| `@cuonghuunguyen/claude-ui` | `packages/claude-ui` | The installable package: the daemon + protocol bundled to one JS file, the web build, the `claude-ui` bin |

Packages are consumed as TypeScript source; the daemon runs with `tsx`.

## Run

Requires Node 22+ and a `claude login` session (no API key needed, ADR 0002). The terminal panel's `node-pty` has no Linux prebuild: `npm install` compiles it (python3, make, g++).

```sh
npm install
npm start          # builds the web app, starts the daemon on http://127.0.0.1:4280
PORT=5000 npm start
CLAUDE_UI_ALLOW_BYPASS=1 npm start   # offer the "Bypass permissions" mode (off by default)
```

Phone access over Tailscale (ADR 0003: private VPN, no hosting). The daemon stays on loopback; `tailscale serve` adds HTTPS, which Web Push needs:

```sh
tailscale serve --bg 4280                       # once; tailnet needs MagicDNS + HTTPS certificates enabled
CLAUDE_UI_HOSTNAME=<machine>.<tailnet>.ts.net npm start   # prints the https pairing URL + QR for the phone
```

Dev mode with hot reload: `npm run dev` (daemon on 4280, Vite on http://127.0.0.1:5173 proxying `/ws`).

## Install from npm

Requires Node 22+ and a `claude login` session. No clone, TypeScript, tsx or Vite needed:

```sh
npx @cuonghuunguyen/claude-ui          # or: npm i -g @cuonghuunguyen/claude-ui && claude-ui
claude-ui --help                       # --port, --roots, --hostname, --allow-bypass, --version
claude-ui --port 5000 --roots ~/work
```

Each flag overrides its environment variable (`PORT`, `CLAUDE_UI_ROOTS`, `CLAUDE_UI_HOSTNAME`, `CLAUDE_UI_ALLOW_BYPASS=1`); the variables keep working. Behavior is the same as `npm start`: pairing URL + QR, Tailscale hostname, push.

`node-pty` (terminal panel) ships prebuilds for Windows and macOS. On Linux and WSL, install compiles it: install `python3`, `make` and `g++` first (Debian/Ubuntu: `sudo apt install build-essential python3`).

## Release (owner step)

1. Bump `version` in `packages/claude-ui/package.json`.
2. `npm ci && npm run typecheck && npm test`.
3. `npm run pack-check -w @cuonghuunguyen/claude-ui`: builds, packs, installs the tarball in a temp dir, runs `--version` / `--help`, starts it on a free port, expects HTTP 200 on `/` and a WebSocket connect with the pairing token.
4. `npm publish -w @cuonghuunguyen/claude-ui` (`prepack` rebuilds; the scope is public through `publishConfig`).

## Windows

Runs natively in PowerShell with Node 22+ (node-pty ships Windows prebuilds: no compiler needed):

```powershell
npm install
npm start                      # http://127.0.0.1:4280
$env:PORT=4281; npm start      # another port
npx @cuonghuunguyen/claude-ui --port 4281   # or the npm package (no clone)
```

- Config (token, VAPID keys, saved state): `%APPDATA%\claude-ui`. A set `XDG_CONFIG_HOME`, or an existing `~/.config/claude-ui` (`%USERPROFILE%\.config\claude-ui`), is used instead, so an earlier pairing stays.
- Terminal panel: `SHELL` when it names a Windows file, else `pwsh`, else Windows PowerShell, else `%COMSPEC%`. Git Bash's `SHELL=/usr/bin/bash` is skipped; set `SHELL` to `C:\Program Files\Git\bin\bash.exe` to get Git Bash.
- `CLAUDE_UI_ROOTS` separates roots with `;`. Default root: `%USERPROFILE%`.
- `npm run dev` needs a POSIX shell (`&`); use `npm start`.

## Windows with WSL: two daemons

The Windows Claude CLI and the WSL Claude CLI are two installs, each with its own `~/.claude` (login, transcripts, settings, MCP servers, plugins). A daemon reads the install of the OS it runs in: it lists, syncs and starts sessions of that side only. One daemon cannot show the other side's sessions. Run one daemon per side:

| Daemon | Start | Projects | URL in the Windows browser |
| --- | --- | --- | --- |
| WSL | in WSL: `npm start` | `/home/...` | http://127.0.0.1:4280 (WSL forwards localhost to Windows) |
| Windows | in PowerShell: `$env:PORT=4281; npm start` or `claude-ui --port 4281` | `C:\...` | http://127.0.0.1:4281 |

- One checkout or install per side: `npm install` builds node-pty and picks the Claude Code binary for its OS, so a WSL `node_modules` does not run on Windows (and the reverse).
- Pair each URL once: each daemon has its own token, and the two origins (ports) keep separate browser storage.
- Log in once per side (`claude login` in WSL and in Windows): the logins are separate too.
- Do not open `/mnt/c/...` projects in the WSL daemon for work you do with the Windows CLI or the VS Code extension on Windows: their sessions live in the Windows `~/.claude`, so the WSL daemon never lists them, and a session the WSL daemon starts there is invisible to the Windows CLI. Open `C:\...` folders in the Windows daemon.
- In NAT networking mode a WSL shell cannot reach the Windows daemon's `127.0.0.1:4281` (the Windows browser can reach both).

Phone over Tailscale (Tailscale on Windows), one HTTPS port per daemon:

```powershell
tailscale serve --bg --https=443 4280    # WSL daemon (through WSL's localhost forwarding)
tailscale serve --bg --https=8443 4281   # Windows daemon
```

Start both with `CLAUDE_UI_HOSTNAME=<machine>.<tailnet>.ts.net`. The Windows daemon's printed pairing URL has no port: open it with `:8443` added (`https://<machine>.<tailnet>.ts.net:8443/#token=...`).

## Check

```sh
npm run typecheck
npm test
```

Adapter fixtures are recorded from a real SDK session: `npm run record-fixture -w @claude-ui/daemon -- <out.jsonl>`, then replace home paths before committing.
