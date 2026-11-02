# Addons {#addons}

An addon changes how claude-ui looks and what it offers in the browser: colour themes, panes next to the chat, a band above the prompt box, slash commands and drawings for code blocks or tool results. You install one from a git repository or a local folder. It is not a [plugin](config-dialogs#how-to-open-them): plugins change Claude Code, addons change this web app.

## Install an addon {#install}

1. Type `/addons` in the prompt box, or choose **Manage addons** in the [palette](palette).
2. Choose **Git repository** and enter the URL and, if you want one, a branch, tag or SHA. Or choose **Local folder** and enter an absolute path on the machine that runs claude-ui.
3. **Install.** claude-ui clones the repository (git runs without any prompt: it uses your credential helper, ssh-agent and ssh keys, and stores nothing), pins the commit and shows the **approval card**.

Addons live on the Hub (the machine that runs claude-ui) and are active in every browser that connects to it. An addon in a project folder is never run: only addons you install here are.

## Approve what it can do {#approval}

The card lists what the addon asks for, one plain line each, and the themes, views, commands and renderers it adds. **Approve and enable** turns it on. Nothing runs before that. An addon can do only what you approve, and it can never send a prompt by itself.

## Update, turn off, remove {#update}

- **Check for updates** (git addons) shows the new commit and the capabilities that were added or removed. **Update** applies exactly that version.
- A version that asks for a capability you have not approved stays off until you approve it. A local folder is read again whenever you open the dialog: an edit that adds a capability needs approval too.
- The switch turns an addon off without removing it: its themes, panes, band, commands and renderers disappear at once. **Uninstall** removes it, and its checkout for a git addon.
- A row in **Error** shows why the addon does not load (a folder that is gone, a broken manifest).
- Repository URLs are shown without a user name or password.

## What an addon can do {#capabilities}

| Capability | What it allows |
| --- | --- |
| `session.read` | Read the messages and tool results of the session it is shown in |
| `prompt.insert` | Put text in the prompt box (it never sends it) |
| `ui.status` | Show a text in the status bar |
| `ui.toast` | Show short messages |
| `ui.pane` | Show panes next to the conversation |
| `ui.band` | Show a band above the prompt box |
| `ui.command` | Add slash commands `/<addon>:<command>` |
| `render.fence:<lang>` | Draw code blocks of that language |
| `render.tool:<name>` | Draw the results of that tool |
| `net:<origin>` | Connect to that origin (for example `https://api.github.com`) |

## How an addon is kept apart {#security}

- Each view runs in an iframe with `sandbox="allow-scripts"`: no cookies, no storage, no access to the app. It never gets the daemon token.
- The daemon serves its files at `/addon/<nonce>/<name>/…`, only while the addon is enabled. The content security policy allows scripts, styles, images and fonts from the addon's own folder, and network only to the `net:` origins you approved. An API that an addon calls must allow the request origin `null` (CORS).
- Every request from a frame goes through the capability gate. Anything not in the table above (sending a prompt, files, shell, git, permission answers) is refused whatever you approved. A refused call shows a toast once per addon and is listed under the addon's row in the dialog (this browser, in memory).
- An addon's stylesheet cannot load images or other styles from outside: the app's own policy blocks them.

## The manifest {#manifest}

`addon.json` at the root of the repository or folder. No build: files are used as committed.

| Field | Meaning |
| --- | --- |
| `name` | Lowercase letters, digits and `-`, up to 64. The namespace of commands and pane ids. Never changes between versions |
| `version`, `description` | Shown in the dialog |
| `capabilities` | The list above; every entry that needs one must be covered |
| `themes` | `[{id, name, light?, dark?}]`, see [themes](#themes) |
| `css` | A `.css` file applied app-wide while the addon is enabled |
| `views` | `[{id, title, entry, kind: "pane" \| "band", phone?}]`. `phone: false` hides the view below 640 px |
| `commands` | `[{name, description, argumentHint?}]` |
| `commandsEntry` | The `.html` that handles commands; the first view's entry when absent |
| `renderers` | `[{fence \| tool, entry}]` |

Paths are relative, without `..`, and must exist. A view needs `ui.pane` or `ui.band`, a command needs `ui.command`, a renderer needs its `render.fence:` or `render.tool:` capability; the install says which is missing.

## Talking to claude-ui from a view {#bridge}

A view is an HTML file that loads its own script (inline scripts are blocked). It sends `{v: 1, id, type, ...}` to `parent` with `postMessage` and gets `{v: 1, id, ok, result}` or `{v: 1, id, ok: false, error: {code, message}}` back.

| Request | Needs | Effect |
| --- | --- | --- |
| `ui.ready {height}` | nothing | Height of a band or a drawing (24-480 px, a band at most 160) |
| `session.read` | `session.read` | `{parts}` of the session; later `session.parts` events carry new or changed parts |
| `prompt.insert {text}` | `prompt.insert` | Text up to 32 KiB into the prompt box (or the draft) |
| `ui.status {text}` | `ui.status` | A status bar entry up to 80 characters; `null` clears it |
| `ui.toast {text}` | `ui.toast` | A toast up to 200 characters |

Events from claude-ui: `init {addon, view, role, session, theme, mode}`, `theme.changed {theme, mode}`, `command.run {name, args}`, `render {fence: {lang, source}}` or `render {tool: {name, input, result}}`, `session.parts`. The example's `bridge.js` wraps this in `call(type, payload)` and `on(type, fn)`.

## Themes {#themes}

A theme has a `light` and a `dark` palette; a mode that is missing or incomplete is not offered (like Dracula, which has no light). A palette has all of these keys, each a `#rrggbb` colour: `bg`, `card`, `side`, `fg`, `muted`, `border`, `primary`, `pfg`, `kw`, `str`, `fn`, `type`, `num`, `cmt`, `varc`, `err`, `warn`, `ok`, `info`. The theme appears in **Settings › Appearance** after the built-in ones, only while its addon is enabled. If you turn the addon off while its theme is picked, the default look shows until you pick another. Diffs and the terminal keep the default colours for an addon theme.

## Panes, band and commands {#views}

- A `pane` view is a pane like Files or Plan: it starts in the side panel, moves to the bottom panel or the main area from its tab menu, and has one tab per session in the main area. The narrow pane switcher lists it.
- A `band` view sits above the prompt box of every session.
- A command `/example:cmd` is listed in the `/` picker, runs in the browser and is never sent. A command never hides a built-in command or a skill: its row is left out when the name is taken.

## Drawing code blocks and tool results {#renderers}

A `fence` renderer draws the code blocks of one language in assistant answers and in your own messages, before the built-in renderers (also the Mermaid diagram). A `tool` renderer draws the result of one tool. Each drawing has a **Show raw** button for the built-in view. The frame is created only when the block is near the screen. If two addons draw the same thing, the Addons dialog has a picker; until you pick, the first by name wins.

## The example addon {#example}

`examples/addons/example/` in the repository shows every feature: a theme, `theme.css`, a pane that counts the parts of the session and has a button for each bridge call, a band with the number of turns and the last tool, `/example:cmd`, and a renderer for ```` ```example ```` blocks. Install it as a local folder.

## Claude Code mods {#claude-code-mods}

A Claude Code *mod* is a plugin with a hooks module that hooks engine events and can draw panes, a band, a status entry and toasts in Claude Code's own windows. It is not an addon. What claude-ui does with one (checked on Claude Code 2.1.285, the version bundled with claude-ui, with a throwaway mod):

- Its hooks module loads only when claude-ui is started with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in the environment; without it the mod does nothing in a claude-ui session.
- With it, the engine hooks run in claude-ui sessions (tool calls, prompts, session start). A command the mod registers works when you type it, but is not listed in the `/` picker.
- Its panes, status entries and toasts reach claude-ui as small system messages, and claude-ui draws none of them: the timeline shows a gray line such as `system/ui_status`. A mod's pane has no content here.

To change claude-ui itself, write an addon.
