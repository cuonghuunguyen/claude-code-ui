// A page left open across an update asks for lazy chunks whose hashed names are gone (the daemon answers 404): reload once to get the new build.
// Guarded per failing chunk so a build that is really broken does not reload forever.
const KEY = "claude-ui.reloadedFor";

export function reloadOnStalePage(target: Pick<Window, "addEventListener"> = window, storage: Pick<Storage, "getItem" | "setItem"> = sessionStorage, reload: () => void = () => location.reload()): void {
  target.addEventListener("vite:preloadError", (e) => {
    const failing = String((e as Event & { payload?: { message?: string } }).payload?.message ?? "unknown");
    try {
      if (storage.getItem(KEY) === failing) return;
      storage.setItem(KEY, failing);
    } catch {
      return; // no sessionStorage: cannot guard against a loop, so do not reload
    }
    e.preventDefault();
    reload();
  });
}
