import { clearDrafts } from "./drafts.ts";

// The daemon prints a pairing URL `/#token=…`; the token is kept in this browser and removed from the address bar.
const KEY = "claude-ui.token";

type Loc = Pick<Location, "hash" | "pathname" | "search">;

/** The token of this browser (read only), undefined when it was never paired. */
export const storedToken = (storage: Pick<Storage, "getItem"> = localStorage): string | undefined => storage.getItem(KEY) ?? undefined;

const daemonAccepts = (token: string) =>
  fetch("/auth", { headers: { authorization: `Bearer ${token}` } }).then(
    (r) => r.status === 204,
    () => false,
  );

/**
 * Takes a `#token=` fragment at page load (GH-282). The fragment always leaves the address bar. A browser that is not paired
 * stores a token of the right shape; a paired one replaces its token only when `GET /auth` accepts the new one, so a link
 * with another token (written by a model, clicked or pasted) never unpairs a working browser.
 */
export async function adoptToken(
  loc: Loc = location,
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
  replaceUrl = (url: string) => history.replaceState(null, "", url),
  accepted: (token: string) => Promise<boolean> = daemonAccepts,
): Promise<"stored" | "kept" | "none"> {
  const candidate = new URLSearchParams(loc.hash.slice(1)).get("token");
  if (!candidate) return "none";
  replaceUrl(loc.pathname + loc.search);
  if (!TOKEN_SHAPE.test(candidate)) return "kept";
  const stored = storedToken(storage);
  if (stored === candidate) return "kept";
  if (stored === undefined) {
    storage.setItem(KEY, candidate);
    return "stored";
  }
  if (await accepted(candidate).catch(() => false)) {
    storage.setItem(KEY, candidate);
    return "stored";
  }
  console.warn("pairing link ignored: this daemon does not accept its token");
  return "kept";
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
