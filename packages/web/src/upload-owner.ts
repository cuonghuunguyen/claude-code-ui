// The new-session tab's upload token (GH-281): uploads made before the session exists are claimed by `session.create {draft}`.
const KEY = "claude-ui.draftUpload";
type Store = Pick<Storage, "getItem" | "setItem">;

/** 64 hex chars from crypto.getRandomValues (works on plain http, unlike randomUUID). */
export function newDraftToken(fill: (a: Uint8Array<ArrayBuffer>) => Uint8Array = (a) => crypto.getRandomValues(a)): string {
  return Array.from(fill(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
}

const defaultStore = (): Store | undefined => {
  try {
    return sessionStorage;
  } catch {
    return undefined;
  }
};

/** This browser tab's token: sessionStorage (survives a reload of the tab, not shared with other tabs), else a new one saved. */
export function draftToken(store: Store | undefined = defaultStore()): string {
  try {
    const saved = store?.getItem(KEY);
    if (saved && /^[0-9a-f]{64}$/.test(saved)) return saved;
  } catch {}
  return rotateDraftToken(store);
}

/** After the first prompt was taken: the next draft gets a new token. */
export function rotateDraftToken(store: Store | undefined = defaultStore()): string {
  const t = newDraftToken();
  try {
    store?.setItem(KEY, t);
  } catch {}
  return t;
}
