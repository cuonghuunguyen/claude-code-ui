# Troubleshooting & FAQ

## Something is wrong

### `npm i` fails on `node-pty` (Linux, WSL)

The terminal panel needs a C++ toolchain. On Debian or Ubuntu:

```sh
sudo apt install build-essential python3
```

### The browser keeps asking to pair

Open the pairing link the daemon printed at start (it ends in `#token=…`). On an iPhone Home Screen app, paste that link into **Pairing link or token** and tap **Pair**. iOS can clear the app's storage after weeks without use; pair again then.

### "This daemon does not accept that token"

The token changed (the `token` file was deleted, or you use a different config folder). Copy the link the daemon printed last.

### Port in use

Start on another port: `claude-ui --port 4281`.

### WSL or Docker side "stopped (exit code 1)"

In 0.5.0 every WSL and Docker side stops about 15 seconds after it starts. This is a known bug: [#263](https://github.com/cuonghuunguyen/claude-code-ui/issues/263). **Retry** starts it again, but it stops again. Windows and local projects are not affected.

### The side needs Node.js or a login

The Open project dialog says what is missing. A side needs Node.js 22+ and a Claude login inside the distro or container. See [WSL & Docker](../features/wsl-docker).

### Push notifications do not work

- The page must be on HTTPS (or `localhost`). Use [`--tailscale`](../features/remote-access).
- On iPhone/iPad: iOS 16.4+, and the app must be on the Home Screen.
- Without HTTPS, the daemon's computer shows desktop notifications instead (Linux needs `notify-send`, package `libnotify-bin`).

### A new version does not start

claude-code-ui falls back to the previous version and says so. See [Updates](../features/updates).

### `--tailscale` exits right away

It prints what is missing: Tailscale not installed or not logged in, MagicDNS or HTTPS certificates off, the machine not approved, or Funnel on. On Linux without root, run `sudo tailscale set --operator=$USER` once.

## FAQ

### Do I need an API key?

No. It uses your Claude subscription through `claude login`.

### Do sessions stop when I close the browser?

No. They run in the daemon. Open the page again to catch up.

### Do sessions stop when I stop the daemon?

The running turn stops. The session and its history stay, and you can continue it after the next start.

### Can I use it on my phone?

Yes. See [Phone & remote access](../features/remote-access).

### Does it work with sessions from the `claude` CLI?

Yes. Both read and write the same history in `~/.claude`. A session started in one shows up in the other.

### How do I unpair all browsers?

Delete the `token` file in the [config folder](cli#files) and restart. Every browser must pair again.

### Is it official?

No. It is a community project, not made by or affiliated with Anthropic.
