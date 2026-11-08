# External apps start only for a browser on the daemon machine

The file menus offer Reveal in the file manager, Open in an editor and Open with the default app (GH-612). The daemon starts these apps, so a WebSocket message makes the daemon machine run an OS command. A browser on another machine must not open windows on the daemon's screen.

Decision: `fs.openExternal` runs only when the connection is from the daemon machine: Host header `localhost`, `127.0.0.1` or `[::1]` and a loopback peer address. The daemon enforces it; the web app only hides the items with the same test. The command is fixed per OS, has no shell (except the Windows `.cmd` editor launcher, with quoted arguments and `%` refused), and gets only canonical paths inside the roots. Editors are a fixed list (VS Code, Cursor, IntelliJ IDEA) detected on the daemon machine.

## Considered options

- **Open for every paired browser**: simple, but a phone or a Tailscale browser would open apps on a screen nobody looks at.
- **Setting to allow remote opens**: more states; no use case.
- **User-configured editor command**: runs arbitrary strings from a request; the fixed list needs no input from it. A Settings command can follow if asked.
- **Same-machine check in the UI only**: a client bug or a hand-made message would bypass it.

## Consequences

- An `ssh -L` tunnel to a remote daemon looks local: the app opens on the daemon machine (wrong screen, harmless).
- A token holder can already run any command through a session, so this adds no privilege.
- Docker and SSH Sides answer `side_unsupported`.
- A daemon in WSL converts the path with `wslpath -w` and starts `explorer.exe` through WSL interop. The Windows Hub forwards the request of a WSL Side path to the Side daemon, only for a browser on the Hub machine. The Side daemon trusts its attached Hubs (a virtual connection has no peer address): an attached Hub is the Windows Hub of the same machine, which checked its browser. Accepted risk: a Hub on another machine attached over SSH into the distro can open Explorer on this machine (same class as the `ssh -L` case above).
- Linux Reveal opens the folder without selecting the file.
