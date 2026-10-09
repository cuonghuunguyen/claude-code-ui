import { clearDrafts } from "./drafts.ts";

// The daemon prints a pairing URL `/#token=…`; the token is kept in this browser and removed from the address bar.
const KEY = "claude-ui.token";

type Loc = Pick<Location, "hash" | "pathname" | "search">;

export function takeToken(
  loc: Loc = location,
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
  replaceUrl = (url: string) => history.replaceState(null, "", url),
): string | undefined {
  const fromUrl = new URLSearchParams(loc.hash.slice(1)).get("token");
  if (fromUrl) {
    storage.setItem(KEY, fromUrl);
    replaceUrl(loc.pathname + loc.search);
  }
  return storage.getItem(KEY) ?? undefined;
}

/** Daemon tokens are 43-char base64url; a shorter one is a typo or something else pasted. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,}$/;

/** The token out of what a person pastes into the pairing field: a pairing URL (any origin), `#token=…`, `token=…` or the bare token. */
export function parsePairing(input: string): string | undefined {
  const text = input.trim();
  const hash = text.slice(text.indexOf("#") + 1); // no "#": the whole text
  const token = hash.includes("=") ? new URLSearchParams(hash).get("token") : hash;
  return token && TOKEN_SHAPE.test(token) ? token : undefined;
}

export const storeToken = (token: string, storage: Pick<Storage, "setItem"> = localStorage) => storage.setItem(KEY, token);
/** Unpairs this browser: the token and the prompt drafts (plain text on this device) go. */
export function clearToken(storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = localStorage): void {
  storage.removeItem(KEY);
  clearDrafts(storage);
}
