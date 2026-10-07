// This browser's Web Push subscription (docs/spec.md "Push notifications"): one on/off toggle.
import type { PushKeyResult } from "@claude-ui/protocol";
import type { connect } from "./client.ts";

type Client = ReturnType<typeof connect>;

/** False on plain http off localhost (no secure context) and in browsers without Web Push. */
export const pushSupported = () => typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

export async function pushSubscription() {
  if (!pushSupported()) return null;
  return (await navigator.serviceWorker.ready).pushManager.getSubscription();
}

/** Asks for notification permission, subscribes with the daemon's VAPID key and registers the subscription with the daemon. */
export async function enablePush(client: Client) {
  if ((await Notification.requestPermission()) !== "granted") throw new Error("notifications are blocked for this site in the browser");
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await client.request<PushKeyResult>({ type: "push.key" });
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey }));
  await sendSubscription(client, sub);
}

/** Registers the subscription again, e.g. after a reconnect: the daemon may have a fresh config dir. */
export const sendSubscription = (client: Client, sub: PushSubscription) =>
  client.request({ type: "push.subscribe", subscription: sub.toJSON() as never });

/** The daemon drops the subscription on its next push, when the push service answers 410 Gone. */
export async function disablePush() {
  await (await pushSubscription())?.unsubscribe();
}
