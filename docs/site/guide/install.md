# Install & first run

claude-code-ui runs a small local server (the **daemon**) on your computer. You open its web page in a browser.

## What you need

- **Node.js 22** or newer.
- **Claude Code, logged in.** Run `claude login` once. claude-code-ui uses your Claude subscription. It does not use an API key.
- **Linux and WSL only:** a C++ toolchain, so the terminal panel can build. On Debian or Ubuntu: `sudo apt install build-essential python3`. Windows and macOS need nothing extra.

## How to start

1. Run it without installing:
   ```sh
   npx claude-code-ui
   ```
   Or install it once. The command is then `claude-ui`:
   ```sh
   npm i -g claude-code-ui
   claude-ui
   ```
2. The terminal prints a **pairing link** (`http://127.0.0.1:4280/#token=…`) and a QR code.
3. Open the link in your browser. The token in the link pairs this browser with the daemon.
4. Click **Open project** and pick a folder.
5. Type a prompt and press <kbd>Enter</kbd>.

A short **guided tour** shows you around the first time. Skip it, or restart it later in **Settings › Guide**.

## Good to know

- Keep the terminal open. Closing it stops the daemon. Your sessions stay saved and come back on the next start.
- Sessions keep running when you close the browser tab.
- By default the daemon only listens on `127.0.0.1` (this computer). To use it from your phone, see [Phone & remote access](../features/remote-access).
- Sessions can only use folders inside your home folder. Change that with [`--roots`](../reference/cli).
- Sessions you start in the `claude` CLI or the VS Code extension show up here too, and the other way round.
- Lost the pairing link? It is printed again at every start.
- Something broke? See [Troubleshooting](../reference/troubleshooting).
