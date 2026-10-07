# Remote access through Tailscale serve

Remote access is Tailscale `serve`: private to the tailnet, HTTPS by Tailscale certificates, no third-party server sees session content (ADR 0003).

- `--tailscale` makes claude-ui check Tailscale and run `tailscale serve --https=443 http://127.0.0.1:<port>` as a foreground child. The serve config lives only while the child runs; nothing persists.
- Funnel (public internet) is never used; start is refused when Funnel is on for the node's port 443 (also by a foreground `tailscale funnel` session) or a foreground serve holds 443.
- `--hostname` stays for other HTTPS proxies; `--lan` stays (plain HTTP, opt-in).
