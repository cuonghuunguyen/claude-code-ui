# No external hosting services

The daemon, the web app and all session data stay on the owner's machine; no cloud hosting, tunnels-as-a-service or third-party servers may receive session content. Remote access (e.g. a private VPN between the owner's devices) is decided later under this constraint. Web Push is allowed: it passes the browser vendor's push service (APNs, FCM), but the payload is end-to-end encrypted with keys only the daemon and the device hold.
