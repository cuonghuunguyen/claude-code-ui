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

## Check

```sh
npm run typecheck
npm test
```

Adapter fixtures are recorded from a real SDK session: `npm run record-fixture -w @claude-ui/daemon -- <out.jsonl>`, then replace home paths before committing.
