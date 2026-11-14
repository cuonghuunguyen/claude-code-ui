// Git argv (without `git`) shared by the web app (dialog preview) and the daemon (what it runs, and checks the request against):
// the command a dialog shows is the command that runs (docs/spec.md "Layout", Graph tab).

/** Every remote operation: no fsmonitor program and no `ext::` transport. */
export const HARDEN = ["-c", "core.fsmonitor=false", "-c", "protocol.ext.allow=never"];

/** New Tag: annotated (`-a -m`) when `message` has text, else lightweight. `hash`: a full commit hash. */
export const tagCreateArgv = (name: string, hash: string, message?: string): string[] => (message?.trim() ? ["tag", "-a", "-m", message, name, hash] : ["tag", name, hash]);

/** Remove Tag, local part. */
export const tagDeleteArgv = (name: string): string[] => ["tag", "-d", name];

/** Remove Tag on a remote: with a lease, so the remote tag is deleted only while it still has the hash the dialog showed. */
export const tagDeleteRemoteArgv = (remote: string, name: string, hash: string): string[] => [
  ...HARDEN,
  "push",
  "--no-recurse-submodules",
  `--force-with-lease=refs/tags/${name}:${hash}`,
  remote,
  "--delete",
  `refs/tags/${name}`,
];
