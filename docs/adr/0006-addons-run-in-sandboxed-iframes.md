# Addons run in sandboxed iframes

Addons (themes, panes, band, commands, renderers installed from git) run in `sandbox="allow-scripts"` iframes served with a strict CSP, and act only through a versioned `postMessage` bridge gated by the capabilities the owner approved. They are not modules loaded into the app.

- Remote access (ADR 0004) means every browser that connects runs the addon. A module in the app would hold the daemon token and reach every daemon API: shell, files, permission approval.
- The frame has an opaque origin: no cookies, no storage, no access to the parent DOM. It never receives the token.
- The daemon serves addon files under `/addon/<nonce>/<name>/…` only while the addon is enabled; the CSP limits scripts, styles and images to that folder and `connect-src` to the `net:` origins the owner approved. This is not a hard network wall: browsers do not apply `connect-src` to WebRTC, so an addon that can read session data (`session.read`) could still send it out that way. The owner trusts the code of an addon they give `session.read`; the approval card is the control.
- Consequences: no direct DOM access to the app; replacing built-ins is limited to fence and tool renderers and CSS; addon authors need CORS that allows `Origin: null` for `net:` APIs.
