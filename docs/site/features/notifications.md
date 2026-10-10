# Notifications

claude-code-ui tells you when a session needs input or finishes. There are three kinds.

| Kind | Where it shows | Needs |
| --- | --- | --- |
| **In-app** | A card in the corner of the open page | Nothing. On by default. |
| **Push** | Your phone or desktop, even with the page closed | HTTPS (or `localhost`) |
| **Desktop** | A system notification on the daemon's computer | Nothing. Used when no browser has push on. |

## How to turn on push

1. Open the app over HTTPS, for example with [`--tailscale`](remote-access), or on `localhost`.
2. On iPhone or iPad (iOS 16.4+): first add the app to the Home Screen and open it from there.
3. Open **Settings › Notifications** and turn on **Push notifications**.
4. Allow notifications when the browser asks.

## In-app cards

- A card shows when a session you are not looking at needs input, finishes or fails.
- For a simple read request, answer right on the card: **Allow once** or **Deny**.
- Anything else: click **Open in Focus** to answer on the [Focus page](focus).
- <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>N</kbd> moves the keyboard focus to the newest card.

## Good to know

- Push is not sent while this page is in front and shows in-app cards.
- Clicking a push notification opens that session.
- Push messages are end-to-end encrypted. They pass the browser vendor's push service (Google, Apple, Mozilla), which cannot read them.
- Desktop notifications use `notify-send` on Linux (package `libnotify-bin`), the notification center on macOS, and a toast on Windows. Turn them off in Settings, or start with `--no-os-notify`.
- All of these are per browser except the desktop switch, which is for the whole daemon.
