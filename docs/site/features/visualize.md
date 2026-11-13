# Inline visualizations

Claude can draw a chart, a diagram or a small interactive widget right in its reply.

## How to use

1. Ask for a picture: "visualize monthly sales as a bar chart".
2. Claude writes the drawing to a file in the session's uploads folder and shows it in the chat. While it is written you see "Drawing visualization…"; the drawing appears when the block is complete. Deleting the session deletes the file: its old replies then show the file as unavailable.
3. **Show code** above the drawing swaps it for its source.

Switch it off in [Settings › Sessions › Chat](../reference/settings#chat). It applies to sessions started or resumed after the change. Off: the drawings show as code.

## Good to know

- The drawing runs in a sandboxed frame. It cannot read the app, your files, cookies or storage, and cannot make network requests. Scripts load only inline or from `cdn.jsdelivr.net`, `cdnjs.cloudflare.com` and `unpkg.com`.
- A script in the drawing could still put data into the address of a CDN script. Claude can already write files, so this adds little, but know it.
- It follows the light/dark theme and the colour theme: colours, series palette and font come from the app, and switch live.
- In a question from Claude, drawings can show in the question and next to each option, side by side for comparison. An interactive drawing there (a slider, a ranking) can fill in **Type your own answer**; you still press Submit.
- It works on Docker, WSL and SSH sides (after the side updates to this build) and with the OpenCode engine. OpenCode gets the guidance with each prompt, so a change of the setting applies from the next prompt.
