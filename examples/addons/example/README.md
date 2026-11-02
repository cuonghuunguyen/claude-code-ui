# Example addon

A claude-ui addon that shows every feature. Own code, MIT license.

Install it from the Addons dialog (`/addons`): choose **Local folder** and enter the path of this folder.

| File | Shows |
| --- | --- |
| `addon.json` | The manifest: capabilities, a theme, views, a command, renderers. |
| `bridge.js` | The addon side of the bridge: `call(type, payload)` and `on(type, fn)`. |
| `theme.css` | Addon CSS, applied while the addon is enabled. |
| `pane.html`, `pane.js` | A pane (view `stats`). |
| `band.html`, `band.js` | A band above the prompt box (view `info`). |
| `command.html`, `command.js` | The handler of `/example:cmd`. |
| `render.html`, `render.js` | A renderer for ```` ```example ```` code blocks and `mcp__example__echo` results. |
