// Unsent prompt text per session, kept in this browser (docs/spec.md "Prompt drafts"): iOS discards a backgrounded page without warning.
// Text only (images are big data URLs). The 30 most recently saved drafts stay; clearDrafts() runs when the browser is unpaired.
const PREFIX = "claude-ui.draft.";
const INDEX = "claude-ui.drafts";
export const MAX_DRAFTS = 30;

/** The draft key of the new-session tab. */
export const NEW_TAB_DRAFT = "new";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const defaultStore = (): Store | undefined => {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
};

/** key -> time of the last save; the cap drops the oldest. */
const readIndex = (s: Store): Record<string, number> => {
  try {
    const v = JSON.parse(s.getItem(INDEX) ?? "{}");
    return typeof v === "object" && v !== null && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
};

export function loadDraft(key: string, store = defaultStore()): string {
  try {
    return store?.getItem(PREFIX + key) ?? "";
  } catch {
    return "";
  }
}

/** Empty text removes the draft. */
export function saveDraft(key: string, text: string, store = defaultStore(), now = Date.now()): void {
  if (!store) return;
  try {
    const index = readIndex(store);
    if (!text) {
      store.removeItem(PREFIX + key);
      delete index[key];
    } else {
      store.setItem(PREFIX + key, text);
      index[key] = now;
      const oldest = Object.entries(index).sort((a, b) => b[1] - a[1]).slice(MAX_DRAFTS);
      for (const [k] of oldest) (store.removeItem(PREFIX + k), delete index[k]);
    }
    store.setItem(INDEX, JSON.stringify(index));
  } catch {
    // Quota or a blocked storage: a draft is a convenience.
  }
}

export function clearDrafts(store = defaultStore()): void {
  if (!store) return;
  try {
    for (const k of Object.keys(readIndex(store))) store.removeItem(PREFIX + k);
    store.removeItem(INDEX);
  } catch {
    // see saveDraft
  }
}
