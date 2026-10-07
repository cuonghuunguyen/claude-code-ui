# Contributing

Spec: `docs/spec.md`. Glossary: `CONTEXT.md`. Decisions: `docs/adr/`.

## Layout (npm workspaces)

| Package | Path | Content |
| --- | --- | --- |
| `@claude-ui/protocol` | `packages/protocol` | Wire protocol, message model (parts), adapter (SDK messages → parts) |
| `@claude-ui/daemon` | `packages/daemon` | Node daemon: HTTP (web app) + WebSocket `/ws`, sessions via `@anthropic-ai/claude-agent-sdk` |
| `@claude-ui/web` | `packages/web` | React + Vite + Tailwind + shadcn/ui + AI Elements |
| `claude-code-ui` | `packages/claude-ui` | The published package: daemon + protocol bundled to `dist/cli.js`, the web build, the `claude-ui` bin (`dist/launcher.js`, runs the newest installed daemon) |

Packages are consumed as TypeScript source; the daemon runs with `tsx`.

## Run from source

Requirements as in the README (Node 22+, `claude login`, on Linux a C++ toolchain for `node-pty`).

```sh
npm install
npm start                            # builds, starts the daemon on http://127.0.0.1:4280
PORT=5000 npm start
CLAUDE_UI_ALLOW_BYPASS=1 npm start
npm run dev                          # hot reload: daemon on 4280, Vite on http://127.0.0.1:5173 proxying /ws
```

Windows (PowerShell): `$env:PORT=4281; npm start`. `npm run dev` needs a POSIX shell (`&`); use `npm start`.

`npm start` also builds `packages/claude-ui`: a WSL side installs from that folder.

## Check

```sh
npm run typecheck
npm test
```

Adapter fixtures are recorded from a real SDK session: `npm run record-fixture -w @claude-ui/daemon -- <out.jsonl>`, then replace home paths before committing.

## Release (owner step)

1. Bump `version` in `packages/claude-ui/package.json`.
2. `npm ci && npm run typecheck && npm test`.
3. `npm run pack-check -w claude-code-ui`: builds, packs, installs the tarball in a temp dir, runs `--version` / `--help`, starts it on a free port, expects HTTP 200 on `/` and a WebSocket connect with the pairing token.
4. `npm publish -w claude-code-ui` (`prepack` rebuilds).
