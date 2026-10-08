import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Whether this process may create symbolic links. Always true on Linux and macOS; on Windows it needs Developer Mode or the
 * "Create symbolic links" privilege (otherwise EPERM), a machine setting a test cannot change.
 */
export const canSymlink: boolean = (() => {
  const dir = mkdtempSync(join(tmpdir(), "symlink-probe-"));
  try {
    writeFileSync(join(dir, "t"), "");
    symlinkSync(join(dir, "t"), join(dir, "l"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

/** Reason shown for a test skipped because `canSymlink` is false. */
export const NO_SYMLINK = "needs symlink creation (Windows: enable Developer Mode or grant the symlink privilege)";

/** A test name that states the skip reason when `canSymlink` is false and stays unchanged otherwise. */
export const needsLinks = (name: string) => (canSymlink ? name : `${name} [skipped: ${NO_SYMLINK}]`);
