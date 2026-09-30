# claude-ui

Browser UI for Claude Agent SDK sessions run by a local daemon. Spec: `docs/spec.md`. Glossary: `CONTEXT.md`.

## Layout (npm workspaces)

| Package | Path | Content |
| --- | --- | --- |
| `@claude-ui/protocol` | `packages/protocol` | Wire protocol, message model (parts), adapter (SDK messages → parts) |
| `@claude-ui/daemon` | `packages/daemon` | Node daemon: HTTP (web app) + WebSocket `/ws`, sessions via `@anthropic-ai/claude-agent-sdk` |
| `@claude-ui/web` | `packages/web` | React + Vite + Tailwind + shadcn/ui + AI Elements |

Packages are consumed as TypeScript source; the daemon runs with `tsx`.

## Run

Requires Node 22+ and a `claude login` session (no API key needed, ADR 0002).

```sh
npm install
npm start          # builds the web app, starts the daemon on http://127.0.0.1:4280
PORT=5000 npm start
```

Dev mode with hot reload: `npm run dev` (daemon on 4280, Vite on http://127.0.0.1:5173 proxying `/ws`).

## Check

```sh
npm run typecheck
npm test
```

Adapter fixtures are recorded from a real SDK session: `npm run record-fixture -w @claude-ui/daemon -- <out.jsonl>`, then replace home paths before committing.
