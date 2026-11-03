# Example addon

A claude-ui addon that shows every feature. Own code, MIT license. Guide: `docs/site/features/addons.md`.

Install it from the Addons dialog (`/addons`): choose **Local folder** and enter the path of this folder. Approve the ten capabilities, then try each part:

| File | Shows | Capability used |
| --- | --- | --- |
| `addon.json` | The manifest: capabilities, a theme, views, a command, renderers | all |
| `claude-ui-addon.js`, `claude-ui-addon.d.ts` | The SDK, copied from `packages/addon-sdk/` (keep both identical to it). Every script has `// @ts-check` | none |
| `theme.css` | Addon CSS, applied while the addon is enabled; the theme "Example Dusk" is in `addon.json` (Settings › Appearance) | none |
| `pane.html`, `pane.js` | Pane "Stats" (not on a phone): part counts (`session.read`, `session.parts`), "Set status" (`ui.status`), "Toast" (`ui.toast`), "Log" (`log`, a line in the Addons dialog log), "Try to submit" (`prompt.submit`, always refused), "Fetch" (`net:https://api.github.com`) | `ui.pane`, `session.read`, `ui.status`, `ui.toast`, `log`, `net:` |
| `band.html`, `band.js` | Band above the prompt box: turns and last tool | `ui.band`, `session.read` |
| `command.html`, `command.js` | `/example:cmd [text]` puts a sample prompt in the prompt box | `ui.command`, `prompt.insert` |
| `render.html`, `render.js` | Draws ```` ```example ```` blocks (word count) and the results of `mcp__example__echo`, with Show raw | `render.fence:example`, `render.tool:mcp__example__echo` |
