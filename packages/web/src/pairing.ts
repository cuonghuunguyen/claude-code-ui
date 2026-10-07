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
