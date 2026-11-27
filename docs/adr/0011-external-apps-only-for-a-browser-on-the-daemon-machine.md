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

## Amendment (GH-646)

The user can set one editor command (Settings `editor`). The command comes from the hub's own settings file, never from a request, a project file or a project environment: `fs.openExternal` carries only `with: "custom"`. Changing it needs a browser on the daemon machine (`settings.set` answers `not_local` otherwise), so a phone or Tailscale browser cannot plant a command for the local user's next click. The daemon splits the line itself and starts the program without a shell. It is not synced to Sides.

## Amendment (GH-1021)

Supersedes "runs only when the connection is from the daemon machine" for opening. Every paired browser (LAN, Tailscale, a phone) gets Reveal, Open in an editor and Open with the default app, and `fs.openExternal` no longer answers `not_local`. The app starts on the daemon machine's screen; when nobody looks at that screen, nothing visible happens, which is accepted. A token holder can already run any command through a session, so this adds no privilege. The command stays fixed per OS, with no shell and canonical paths inside the roots. Docker and SSH Sides still answer `side_unsupported`.

- A WSL Side daemon no longer needs to trust its attached Hubs for opening: it does not check the origin of the browser. The Windows Hub forwards the request of a WSL Side path for any browser. The accepted-risk note about a Hub on another machine in Consequences no longer adds anything for opening.
- The rule of the GH-646 amendment stays: `settings.set` with `editor` answers `not_local` for a browser not on the daemon machine, so a remote browser cannot plant a command for the local user's next click. Settings › Open in app shows the values read-only for such a browser, with one line saying why.
- A browser not on the daemon machine does not know the daemon's OS: the file manager entry uses the neutral name "Open Containing Folder".
- Every daemon, a Docker or SSH Side daemon too, starts with `openExternal`. The Hub router is the only block for those Sides; a client with that Side daemon's own token could ask it directly. Accepted: a token holder can already run any command.
