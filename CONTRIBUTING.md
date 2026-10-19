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
npm run e2e                          # local only: real Claude on Haiku, see packages/e2e/README.md
```

Adapter fixtures are recorded from a real SDK session: `npm run record-fixture -w @claude-ui/daemon -- <out.jsonl>`, then replace home paths before committing.

## Docs

The docs site (VitePress) lives in `docs/site/` and is published to GitHub Pages by `.github/workflows/docs.yml` on every push to `main` that touches it.

```sh
npm run docs:dev        # live preview on http://localhost:5173/claude-code-ui/
npm run docs:build      # production build into docs/site/.vitepress/dist; fails on dead links
npm run docs:preview    # serve that build
```

- One Markdown page per feature in `docs/site/features/`. Keep it short: one-sentence intro, **How to use** steps, a few **Good to know** bullets.
- `docs/site/reference/shortcuts.md` is generated from `packages/web/src/shortcuts.ts` and `leader.ts` (`npm run docs:shortcuts`, run by `docs:dev` and `docs:build`). Edit the registry, not the page.
- Screenshots are generated, not taken by hand: `npm run docs:shots [scene...]` writes `docs/site/public/screenshots/<scene>[-dark].png`.

### Screenshot scenes

The real web app runs against a scripted fake daemon and Playwright captures it. `packages/web/vite.scenes.config.ts` redirects every import of `src/client.ts` to `packages/web/scenes/fake-client.ts`, which answers requests and pushes events from the scene named in the URL (`scenes.html?scene=<name>`). The normal build is untouched.

- A scene is one file in `packages/web/scenes/scenes/` that exports a `Scene` (`scenes/scene.ts`): its sessions (list entry plus the parts of its timeline), projects, the URL hash to open (`#new`, `#focus`, `#<session id>`), localStorage to seed (layout, selected panes, open tabs), the viewport (default 1440x900), the themes (`light`, add `dark`), optional `replies` for requests the defaults in `fake-client.ts` do not cover, optional Playwright `steps` (open a menu) and an optional `clip` selector. Data is typed against `@claude-ui/protocol`, so a wire change fails `npm run typecheck`.
- To add one: copy a scene file, register it in `scenes/index.ts` (the key is the PNG name), run `npm run docs:shots <name>` and look at the PNG. A request the fake does not know resolves `{}` and logs `[scene] unhandled request "<type>"`: add a default reply in `fake-client.ts` when the screen needs it.
- Time is frozen to `NOW` in `scenes/demo.ts`; express timestamps relative to it.
- Demo data rule: only the invented `demo-shop` / `demo-api` projects from `scenes/demo.ts`, made-up branches and session titles. No real names, paths, usernames or session text.

## Release (owner step)

1. Bump `version` in `packages/claude-ui/package.json`.
2. Docs check, against the changelog entries since the last tag (`git log --merges <last tag>..`):
   - Each user-visible change is described on its feature page in `docs/site/features/` (or a reference page). A feature with no page gets one, and a sidebar entry in `docs/site/.vitepress/config.ts`.
   - Screenshots of a changed screen are retaken (`npm run docs:shots`).
   - `npm run docs:build` passes (dead links fail it).
3. `npm ci && npm run typecheck && npm test`.
4. `npm run pack-check -w claude-code-ui`: builds, packs, installs the tarball in a temp dir, runs `--version` / `--help`, starts it on a free port, expects HTTP 200 on `/` and a WebSocket connect with the pairing token.
5. `npm publish -w claude-code-ui` (`prepack` rebuilds).
