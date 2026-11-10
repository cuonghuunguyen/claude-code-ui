# Inline visualizations

Claude can draw a chart, a diagram or a small interactive widget right in its reply.

## How to use

1. Ask for a picture: "visualize monthly sales as a bar chart".
2. Claude answers with a drawing in the chat. While it is written you see the code; the drawing appears when the block is complete.
3. **Show code** above the drawing swaps it for its source.

Switch it off in [Settings › Sessions › Chat](../reference/settings#chat). It applies to sessions started or resumed after the change. Off: the drawings show as code.

## Good to know

- The drawing runs in a sandboxed frame. It cannot read the app, your files, cookies or storage, and cannot make network requests. Scripts load only inline or from `cdn.jsdelivr.net`, `cdnjs.cloudflare.com` and `unpkg.com`.
- A script in the drawing could still put data into the address of a CDN script. Claude can already write files, so this adds little, but know it.
- It follows the light/dark theme and the colour theme.
- Sessions on Docker, WSL or SSH sides do not have the skill yet: Claude draws there only if you ask for a ```` ```visualize ```` block, and the app still renders it.
- The OpenCode engine has no skill; a `visualize` block it writes still renders.
