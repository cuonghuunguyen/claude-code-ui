// The `ssh [user@]host [-p N] [-i key] [-J jump]` command of Add SSH host (docs/spec.md "Sides"): the hub validates it, the web previews it.

/** What `ssh user@host -p N -i key -J jump` names. */
export type SshTarget = { host: string; user?: string; port?: number; identity?: string; jump?: string };

/**
 * The target of an `ssh [options] [user@]host` command line: options -p, -i, -J, -l and one destination. Anything else (other options,
 * a remote command, a missing host, characters that would change the config file) throws an Error with the reason.
 */
export function parseSshCommand(text: string): SshTarget {
  const tokens = [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!);
  if (tokens[0] === "ssh") tokens.shift();
  const o: Record<string, string> = {};
  let dest: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (!t.startsWith("-") || t === "-") {
      if (dest !== undefined) throw new Error(`Unexpected "${t}" after the host. Give only: ssh [user@]host [-p port] [-i key] [-J jump].`);
      dest = t;
      continue;
    }
    const flag = t.slice(0, 2);
    if (!["-p", "-i", "-J", "-l"].includes(flag)) throw new Error(`The ssh option ${flag} is not supported. Supported: -p, -i, -J, -l.`);
    const value = t.length > 2 ? t.slice(2) : tokens[++i];
    if (!value) throw new Error(`The ssh option ${flag} needs a value.`);
    o[flag] = value;
  }
  if (!dest) throw new Error("No host found. Example: ssh user@example.com -p 2222");
  const at = dest.lastIndexOf("@");
  const user = at >= 0 ? dest.slice(0, at) : o["-l"];
  const host = at >= 0 ? dest.slice(at + 1) : dest;
  if (!/^[A-Za-z0-9_][\w.:-]*$/.test(host)) throw new Error(`"${host}" is not a valid host name.`);
  const clean = (v: string | undefined, what: string, spaces = false) => {
    if (v !== undefined && (/[\x00-\x1f\x7f"'\\#%$]/.test(v) || v.startsWith("=") || (!spaces && /\s/.test(v)) || v.startsWith("-"))) throw new Error(`The ${what} "${v}" has characters that are not allowed.`);
    return v;
  };
  const port = o["-p"] === undefined ? undefined : Number(o["-p"]);
  if (port !== undefined && !(Number.isInteger(port) && port >= 1 && port <= 65535)) throw new Error(`"${o["-p"]}" is not a port (1 to 65535).`);
  return { host, ...(clean(user, "user") && { user }), ...(port !== undefined && { port }), ...(clean(o["-i"], "key path", true) && { identity: o["-i"] }), ...(clean(o["-J"], "jump host") && { jump: o["-J"] }) };
}
