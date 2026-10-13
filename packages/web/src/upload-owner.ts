// The new-session tab's upload token (GH-281): uploads made before the session exists are claimed by `session.create {draft}`.
const KEY = "claude-ui.draftUpload";
export type UploadOwner = { sessionId: string } | { draft: string };

/** The new-session tab's upload owner: the session its failed first prompt left in the same project (token spent), else the draft token. */
export function uploadOwnerFor(unprompted: { id: string; cwd: string } | undefined, project: string, token: string): UploadOwner {
  return unprompted?.cwd === project ? { sessionId: unprompted.id } : { draft: token };
}

/** A draft token the daemon refuses as spent (a copy of it, from a duplicated tab, was claimed first) is replaced and the upload retried once. */
export async function uploadWithRetry(send: (owner: UploadOwner) => Promise<string>, owner: () => UploadOwner, rotate: () => void): Promise<string> {
  try {
    return await send(owner());
  } catch (e) {
    if ((e as { code?: string }).code !== "draft_claimed" || !("draft" in owner())) throw e;
    rotate();
    return send(owner());
  }
}

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
