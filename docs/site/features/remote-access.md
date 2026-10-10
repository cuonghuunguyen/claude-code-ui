# Phone & remote access

By default only your own computer can open claude-code-ui. To use it from your phone or another computer, pick one way:

<img src="/screenshots/phone.png" alt="claude-code-ui on a phone" width="300">

| Way | Works from | HTTPS (push, install as app) | Setup |
| --- | --- | --- | --- |
| **Tailscale** (recommended) | Anywhere, only your devices | Yes | `--tailscale` |
| **Your own HTTPS proxy** | Wherever the proxy is reachable | Yes | `--hostname` |
| **LAN** | Your local network | No | `--lan` |

## Tailscale

1. Install [Tailscale](https://tailscale.com) on the computer and the phone, and log in on both.
2. In the Tailscale admin console (DNS page), turn on **MagicDNS** and **HTTPS certificates**.
3. Start with:
   ```sh
   claude-ui --tailscale
   ```
4. It prints an `https://<machine>.<tailnet>.ts.net/#token=…` link and a QR code. Scan it with the phone.

claude-ui tells you what is missing and exits if Tailscale is not ready.

## Install as an app

Needs HTTPS (Tailscale or your own proxy).

- **Android Chrome:** menu › **Install app**.
- **iPhone/iPad (iOS 16.4+), Safari:** **Share** › **Add to Home Screen**. Open the new app, paste the pairing link the terminal printed into **Pairing link or token**, and tap **Pair**.
- **Desktop Chrome:** the install icon in the address bar.

## LAN

```sh
claude-ui --lan
```

It prints a pairing link for each local address, like `http://192.168.1.20:4280/#token=…`.

::: warning Plain HTTP
Anyone on the network can read the token. Use `--lan` only on a network you trust. Push notifications, Copy buttons and installing the app do not work over plain HTTP.
:::

## Your own HTTPS proxy

<details>
<summary>Show the steps</summary>

Put a reverse proxy that keeps the `Host` header in front of `127.0.0.1:4280`, then start with its name:

```sh
claude-ui --hostname my-machine.local
```

For example with [Caddy](https://caddyserver.com): `caddy reverse-proxy --from my-machine.local --to 127.0.0.1:4280` (trust Caddy's local certificate on the phone).

</details>

## Good to know

- Tailscale's public **Funnel** is never used. claude-ui refuses to start if Funnel is on for that port.
- `tailscale serve` runs only while claude-ui runs. Nothing stays configured after it exits. If you already set up `tailscale serve --bg 4280`, claude-ui reuses it.
- WSL2 is not reachable from the LAN by default. Run claude-ui on Windows, or turn on WSL mirrored networking.
- The page reconnects by itself when the phone wakes up or the network comes back.
- Treat the pairing link like a password: it gives full access. See [Privacy](../reference/privacy).
