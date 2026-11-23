// Addons (docs/spec.md "Addons", ADR 0006): browser customizations installed from git or a local folder on the Hub.
// The daemon validates the manifest, keeps what the owner approved, pins git checkouts to a SHA and serves the files of enabled addons.
import { lstatSync, mkdirSync, watch as fsWatch, readFileSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  AddonCandidate,
  AddonInfo,
  AddonManifest,
  AddonPalette,
  AddonSource,
  AddonThemeVars,
  AddonUpdateCheck,
  AddonsListResult,
  ClientMessage,
} from "@claude-ui/protocol";
import { ADDON_GRAPH_SIZE, MAX_THEME_VARS, varNameError, varValueError } from "@claude-ui/protocol";
import { ConfigError } from "./config.ts";
import { assetKey, assetType, ARTIFACT_ASSET_HEADERS } from "./artifact-preview.ts";
import { BATCH_SSH, runGit, type GitRunner } from "./git-runner.ts";
import { redactUrls, tidy } from "./git-remote.ts";
import { createJsonFile } from "./json-file.ts";
import { themeRoot } from "./addon-css.ts";
import { lintAddon } from "./addon-lint.ts";

export type AddonsRequest = Extract<ClientMessage, { type: `addons.${string}` }>;

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const FIXED = new Set(["session.read", "prompt.insert", "ui.status", "ui.toast", "ui.pane", "ui.band", "ui.command", "log"]);
/** Capability syntax; anything else is refused. */
export const CAPABILITY = {
  fixed: FIXED,
  fence: /^render\.fence:[A-Za-z0-9_+.#-]{1,32}$/,
  tool: /^render\.tool:[A-Za-z0-9_.-]{1,128}$/,
  net: /^net:(.+)$/,
};
/** A palette value goes into a <style> text (no `;{}` injection); the web app takes only `#rrggbb` (its token builder mixes colours and adds alpha to hex), so a theme is checked the same way here. */
const COLOR = /^#[0-9a-f]{6}$/i;
/** The palette keys of themes.ts `KEYS`: a mode that is given needs all of them (else the web app would drop it silently). */
const PALETTE_KEYS = ["bg", "card", "side", "fg", "muted", "border", "primary", "pfg", "kw", "str", "fn", "type", "num", "cmt", "varc", "err", "warn", "ok", "info"];
const GIT_TIMEOUT = 5 * 60_000;
const MAX_ERROR = 400;
const MAX_DEPTH = 3;
const MAX_THEME_OPTIONS = 4;
const MAX_CANDIDATES = 50;

const bad = (msg: string) => new ConfigError("bad_manifest", msg);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function capabilityOk(c: unknown): c is string {
  if (typeof c !== "string") return false;
  if (FIXED.has(c) || CAPABILITY.fence.test(c) || CAPABILITY.tool.test(c)) return true;
  const o = CAPABILITY.net.exec(c)?.[1];
  if (!o) return false;
  try {
    const u = new URL(o);
    return u.origin === o && (u.protocol === "http:" || u.protocol === "https:");
  } catch {
    return false;
  }
}

/** The file a manifest path names inside `root`: relative, no `..`, no backslash, exists (real path within the root), with the extension. */
function pathOk(root: string, p: unknown, ext: string, what: string): string {
  if (typeof p !== "string" || p === "" || p.includes("\0") || p.includes("\\") || isAbsolute(p) || p.split("/").some((s) => s === ".." || s === "" || s === ".")) throw bad(`${what}: invalid path`);
  if (extname(p).toLowerCase() !== ext) throw bad(`${what}: must be a ${ext} file`);
  try {
    const real = realpathSync(join(root, p));
    if (!within(realpathSync(root), real) || !statSync(real).isFile()) throw 0;
  } catch {
    throw bad(`${what}: file not found in the addon: ${p}`);
  }
  return p;
}
const within = (dir: string, path: string) => {
  const rel = relative(dir, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
};
const str = (v: unknown, what: string, max = 200): string => {
  if (typeof v !== "string" || v === "" || v.length > max) throw bad(`${what}: required text up to ${max} characters`);
  return v;
};
const id = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !NAME.test(v) || v.length > 64) throw bad(`${what}: must match ${NAME} (up to 64 characters)`);
  return v;
};
const list = (v: unknown, what: string): unknown[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw bad(`${what}: must be a list`);
  return v;
};

/** `themes[].vars`: per mode a map of custom properties; checked by protocol addon-theme.ts (names, values, palette tokens). Undefined when none are given. */
function themeVars(raw: unknown, tid: string): AddonThemeVars | undefined {
  if (raw === undefined) return undefined;
  if (!isObj(raw)) throw bad(`themes[${tid}].vars: not an object`);
  const out: AddonThemeVars = {};
  for (const [mode, m] of Object.entries(raw)) {
    if (mode !== "light" && mode !== "dark") throw bad(`themes[${tid}].vars.${mode}: only light and dark`);
    if (!isObj(m)) throw bad(`themes[${tid}].vars.${mode}: not an object`);
    const entries = Object.entries(m);
    if (entries.length > MAX_THEME_VARS) throw bad(`themes[${tid}].vars.${mode}: at most ${MAX_THEME_VARS}`);
    const vars: Record<string, string> = {};
    for (const [name, value] of entries) {
      const err = varNameError(name) ?? (typeof value !== "string" ? "var value must be text" : varValueError(value));
      if (err) throw bad(`themes[${tid}].vars.${mode}.${name.slice(0, 50)}: ${err}`);
      vars[name] = value as string;
    }
    if (entries.length) out[mode] = vars;
  }
  return out.light || out.dark ? out : undefined;
}

/** Missing capability per manifest entry, e.g. `views[stats] needs capability ui.pane`. */
export function coverageErrors(m: Pick<AddonManifest, "capabilities" | "views" | "commands" | "renderers">): string[] {
  const has = new Set(m.capabilities);
  const out: string[] = [];
  const need = (what: string, cap: string) => has.has(cap) || out.push(`${what} needs capability ${cap}`);
  for (const v of m.views) need(`views[${v.id}]`, v.kind === "pane" ? "ui.pane" : "ui.band");
  for (const c of m.commands) need(`commands[${c.name}]`, "ui.command");
  for (const r of m.renderers) "fence" in r ? need(`renderers[fence ${r.fence}]`, `render.fence:${r.fence}`) : need(`renderers[tool ${r.tool}]`, `render.tool:${r.tool}`);
  return out;
}

/** Validates addon.json (already parsed) of the addon at `root`; the returned manifest holds only known fields. */
export function parseManifest(raw: unknown, root: string): AddonManifest {
  if (!isObj(raw)) throw bad("addon.json is not a JSON object");
  const name = id(raw.name, "name");
  const capabilities = list(raw.capabilities, "capabilities").map((c) => {
    if (!capabilityOk(c)) throw bad(`invalid capability "${String(c)}"`);
    return c;
  });
  const seen = (set: Set<string>, key: string, what: string) => (set.has(key) ? bad(`${what}: duplicate`) : void set.add(key));
  const themeIds = new Set<string>();
  const themes = list(raw.themes, "themes").map((t, i) => {
    if (!isObj(t)) throw bad(`themes[${i}]: not an object`);
    const tid = id(t.id, `themes[${i}].id`);
    const err = seen(themeIds, tid, `themes[${tid}]`);
    if (err) throw err;
    const palette = (mode: "light" | "dark"): AddonPalette | undefined => {
      const p = t[mode];
      if (p === undefined) return undefined;
      if (!isObj(p)) throw bad(`themes[${tid}].${mode}: not an object`);
      const out: Record<string, string> = {};
      let graph: string[] | undefined;
      for (const [k, v] of Object.entries(p)) {
        if (!/^[a-z]+$/.test(k)) throw bad(`themes[${tid}].${mode}.${k}: invalid key`);
        if (k === "graph") {
          if (!Array.isArray(v) || v.length !== ADDON_GRAPH_SIZE || v.some((c) => typeof c !== "string" || !COLOR.test(c))) throw bad(`themes[${tid}].${mode}.graph: must be ${ADDON_GRAPH_SIZE} colours as #rrggbb`);
          graph = v as string[];
          continue;
        }
        if (typeof v !== "string" || !COLOR.test(v)) throw bad(`themes[${tid}].${mode}.${k}: not a colour`);
        out[k] = v;
      }
      const missing = PALETTE_KEYS.filter((k) => !(k in out));
      if (missing.length) throw bad(`themes[${tid}].${mode}: missing ${missing.join(", ")}`);
      return { ...out, ...(graph && { graph }) };
    };
    const vars = themeVars(t.vars, tid);
    const light = palette("light");
    const dark = palette("dark");
    const rawOptions = list(t.options, `themes[${tid}].options`);
    if (rawOptions.length > MAX_THEME_OPTIONS) throw bad(`themes[${tid}].options: at most ${MAX_THEME_OPTIONS}`);
    const optionIds = new Set<string>();
    const options = rawOptions.map((o, j) => {
      if (!isObj(o)) throw bad(`themes[${tid}].options[${j}]: not an object`);
      const oid = o.id;
      if (typeof oid !== "string" || !NAME.test(oid) || oid.length > 24) throw bad(`themes[${tid}].options[${j}].id: must match ${NAME} (up to 24 characters)`);
      const dup = seen(optionIds, oid, `themes[${tid}].options[${oid}]`);
      if (dup) throw dup;
      if (o.default !== undefined && typeof o.default !== "boolean") throw bad(`themes[${tid}].options[${oid}].default: must be true or false`);
      return { id: oid, label: str(o.label, `themes[${tid}].options[${oid}].label`, 40), ...(o.default !== undefined && { default: o.default }) };
    });
    const css = t.css === undefined ? undefined : pathOk(root, t.css, ".css", `themes[${tid}].css`);
    return { id: tid, name: str(t.name, `themes[${tid}].name`, 64), ...(light && { light }), ...(dark && { dark }), ...(vars && { vars }), ...(options.length && { options }), ...(css && { css }) };
  });
  const viewIds = new Set<string>();
  const views: AddonManifest["views"] = list(raw.views, "views").map((v, i) => {
    if (!isObj(v)) throw bad(`views[${i}]: not an object`);
    const vid = id(v.id, `views[${i}].id`);
    const err = seen(viewIds, vid, `views[${vid}]`);
    if (err) throw err;
    if (v.kind !== "pane" && v.kind !== "band") throw bad(`views[${vid}].kind: must be pane or band`);
    if (v.phone !== undefined && typeof v.phone !== "boolean") throw bad(`views[${vid}].phone: must be a boolean`);
    return { id: vid, title: str(v.title, `views[${vid}].title`, 64), entry: pathOk(root, v.entry, ".html", `views[${vid}].entry`), kind: v.kind, ...(v.phone !== undefined && { phone: v.phone }) };
  });
  const cmdNames = new Set<string>();
  const commands = list(raw.commands, "commands").map((c, i) => {
    if (!isObj(c)) throw bad(`commands[${i}]: not an object`);
    const cn = id(c.name, `commands[${i}].name`);
    const err = seen(cmdNames, cn, `commands[${cn}]`);
    if (err) throw err;
    return { name: cn, description: str(c.description, `commands[${cn}].description`, 200), ...(c.argumentHint !== undefined && { argumentHint: str(c.argumentHint, `commands[${cn}].argumentHint`, 64) }) };
  });
  const renderers = list(raw.renderers, "renderers").map((r, i) => {
    if (!isObj(r)) throw bad(`renderers[${i}]: not an object`);
    if ((r.fence === undefined) === (r.tool === undefined)) throw bad(`renderers[${i}]: exactly one of fence or tool`);
    const entry = pathOk(root, r.entry, ".html", `renderers[${i}].entry`);
    return r.fence !== undefined ? { fence: str(r.fence, `renderers[${i}].fence`, 32), entry } : { tool: str(r.tool, `renderers[${i}].tool`, 128), entry };
  });
  const m: AddonManifest = {
    name,
    version: str(raw.version, "version", 64),
    description: raw.description === undefined ? "" : str(raw.description, "description", 500),
    capabilities,
    themes,
    ...(raw.css !== undefined && { css: pathOk(root, raw.css, ".css", "css") }),
    views,
    commands,
    ...(raw.commandsEntry !== undefined && { commandsEntry: pathOk(root, raw.commandsEntry, ".html", "commandsEntry") }),
    renderers,
  };
  const missing = coverageErrors(m);
  if (missing.length) throw bad(missing.join("; "));
  return m;
}

/** CSP of an addon page, one directive per entry with its reason; relax here only (docs/spec.md "Security"). `base` is http://<host>/addon/<nonce>/<name>/ (never 'self': the frame is an opaque origin). */
export function addonCsp(base: string, net: string[]): string {
  return [
    "sandbox allow-scripts", // opaque origin: no cookies, storage or parent DOM; scripts only
    "default-src 'none'",
    `script-src ${base}`, // the addon's own files; inline script is blocked
    `style-src ${base}`,
    `img-src ${base} data:`,
    `font-src ${base}`,
    `connect-src ${net.length ? net.join(" ") : "'none'"}`, // only the origins the owner approved (net:)
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'", // only the app embeds it
  ].join("; ");
}
export const addonHeaders = (base: string, net: string[]) => ({
  "content-type": "text/html; charset=utf-8",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store", // local edits show on reload
  "referrer-policy": "no-referrer",
  "content-security-policy": addonCsp(base, net),
});
/** Headers of a non-HTML addon file (the sandbox CSP stays: a file opened as a document is inert). */
export const addonAssetHeaders = ARTIFACT_ASSET_HEADERS;

/** The file `rest` (the percent-encoded path after /addon/<nonce>/<name>/) names inside `root`: no dot segment, no link, within the root, a known type (or .html). */
export function addonFile(root: string, rest: string): { path: string; type: string } | undefined {
  const key = assetKey(rest);
  if (key === undefined || key.split("/").some((s) => s.startsWith("."))) return undefined;
  const type = extname(key).toLowerCase() === ".html" ? "text/html; charset=utf-8" : assetType(key);
  if (!type) return undefined;
  try {
    const path = join(root, key);
    if (lstatSync(path).isSymbolicLink()) return undefined;
    const real = realpathSync(path);
    if (!within(realpathSync(root), real) || !statSync(real).isFile()) return undefined;
    return { path: real, type };
  } catch {
    return undefined;
  }
}

/** `dev`: dev mode (local folder only): the daemon watches the folder while the addon is enabled. */
type Record_ = { source: AddonSource; sha?: string; approved: string[]; enabled: boolean; dev?: boolean };
/** The part of `fs.watch` dev mode uses (tests inject a fake). */
export type WatchFn = (path: string, opts: { recursive: boolean }, cb: (event: string, file: string | null) => void) => { close(): void; on(event: "error", cb: () => void): unknown };
const DEV_DEBOUNCE_MS = 150;
type State = { addons: Record<string, Record_>; picks: Record<string, string> };
const parseState = (raw: unknown): State => {
  const out: State = { addons: {}, picks: {} };
  if (!isObj(raw)) return out;
  if (isObj(raw.addons))
    for (const [k, v] of Object.entries(raw.addons)) {
      if (!NAME.test(k) || !isObj(v) || !isObj(v.source)) continue;
      const s = v.source;
      const source: AddonSource | undefined =
        s.kind === "git" && typeof s.url === "string" ? { kind: "git", url: s.url, ...(typeof s.ref === "string" && { ref: s.ref }), ...(typeof s.path === "string" && s.path !== "" && { path: s.path }) } : s.kind === "local" && typeof s.path === "string" ? { kind: "local", path: s.path } : undefined;
      if (!source) continue;
      out.addons[k] = { source, ...(typeof v.sha === "string" && { sha: v.sha }), approved: Array.isArray(v.approved) ? v.approved.filter((c): c is string => typeof c === "string") : [], enabled: v.enabled === true, ...(v.dev === true && source.kind === "local" && { dev: true }) };
    }
  if (isObj(raw.picks)) for (const [k, v] of Object.entries(raw.picks)) if (typeof v === "string") out.picks[k] = v;
  return out;
};

const declared = (m: AddonManifest) => m.capabilities;
const covered = (m: AddonManifest, approved: string[]) => declared(m).every((c) => approved.includes(c));
/** Root of the addon files. A git subfolder whose real path leaves the checkout (a symlink) gives a path that does not exist, so load() reports "addon.json not found". */
const rootOf = (dir: string, name: string, r: Record_) => {
  if (r.source.kind !== "git") return r.source.path;
  const checkout = join(dir, "addons", name);
  if (!r.source.path) return checkout;
  const root = join(checkout, r.source.path);
  try {
    if (within(realpathSync(checkout), realpathSync(root))) return root;
  } catch {
    // missing: the load error says so
  }
  return join(checkout, ".missing");
};

/** A repo-relative subfolder: up to 3 segments, none empty, `.`, `..`, `.git` or starting with `-`; no backslash, NUL or leading slash. */
const subpathOk = (p: unknown): p is string =>
  typeof p === "string" && p !== "" && !p.includes("\0") && !p.includes("\\") && !isAbsolute(p) && p.split("/").length <= 3 && p.split("/").every((s) => s !== "" && s !== "." && s !== ".." && s !== ".git" && !s.startsWith("-"));

/** The manifest of the addon on disk, or the error that stops it loading. */
function load(root: string, name: string): { manifest: AddonManifest } | { error: string } {
  try {
    const m = parseManifest(JSON.parse(readFileSync(join(root, "addon.json"), "utf8")), root);
    if (m.name !== name) return { error: `name changed from "${name}" to "${m.name}"` };
    return { manifest: m };
  } catch (e) {
    return { error: e instanceof SyntaxError ? "addon.json is not valid JSON" : e instanceof ConfigError ? e.message : (e as NodeJS.ErrnoException).code === "ENOENT" ? "addon.json not found" : `cannot read the addon: ${(e as Error).message}` };
  }
}

/** The wire form of a stored addon; the URL never leaves with userinfo. `nonce`: set when files are served (base of an enabled addon). `last` (dev mode): the last good manifest, used with `error` when addon.json does not load right now. `rev`: dev mode revision. */
export function toInfo(name: string, r: Record_, dir: string, nonce = "", last?: AddonManifest, rev?: number): AddonInfo {
  const source: AddonSource = r.source.kind === "git" ? { ...r.source, url: redactUrls(r.source.url) } : r.source;
  const root = rootOf(dir, name, r);
  const l = load(root, name);
  const base = { name, source, ...(r.sha && { sha: r.sha }), approved: r.approved, ...(r.dev && { dev: true, ...(rev !== undefined && { rev }) }) };
  const manifest = "manifest" in l ? l.manifest : r.dev ? last : undefined;
  if (!manifest) return { ...base, state: "error", error: redactUrls((l as { error: string }).error) };
  const state = !covered(manifest, r.approved) ? "needs_approval" : r.enabled ? "enabled" : "disabled";
  const lint = lintAddon(root, manifest); // warnings only (addon-lint.ts): never changes the state
  return { ...base, manifest, ...("error" in l && { error: redactUrls(l.error) }), ...(lint.length && { lint }), state, ...(state === "enabled" && { base: `/addon/${nonce}/${name}/` }) };
}

const err = (code: string, msg: string) => new ConfigError(code, msg);

/** `watch`, `devDebounceMs`: dev mode's file watcher and its debounce (tests inject both). */
export function createAddons(opts: { dir: string; file: string; git?: GitRunner; onChanged: () => void; watch?: WatchFn; devDebounceMs?: number }) {
  const dir = resolve(opts.dir);
  const store = createJsonFile<State>(opts.file, parseState, "addons");
  const run = opts.git ?? runGit;
  const nonce = randomBytes(16).toString("hex");
  /** The `latest` of the last checkUpdate per addon: only that SHA can be applied. */
  const checked = new Map<string, string>();
  /** Addons whose manifest loaded and covered their approvals when a page was last served. */
  const valid = new Set<string>();
  const watch: WatchFn = opts.watch ?? ((p, o, cb) => fsWatch(p, o, (e, f) => cb(e, f === null || f === undefined ? null : String(f))));
  /** Dev mode: one watcher per enabled dev addon, with its debounce timer. */
  const watchers = new Map<string, { w: { close(): void }; timer?: NodeJS.Timeout }>();
  /** Dev mode: the last manifest that loaded (kept while an edit leaves addon.json broken) and the revision that changes at every edit. */
  const lastGood = new Map<string, AddonManifest>();
  const revs = new Map<string, number>();
  const bump = (name: string) => revs.set(name, Math.max((revs.get(name) ?? 0) + 1, Date.now()));

  const env = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "", GCM_INTERACTIVE: "never", ...(!(process.env.GIT_SSH_COMMAND || process.env.GIT_SSH) && { GIT_SSH_COMMAND: BATCH_SSH }) });
  const git = async (cwd: string, args: string[]): Promise<string> => {
    try {
      return (await run({ cwd, args: ["-c", "core.fsmonitor=false", "-c", "protocol.ext.allow=never", ...args], env: env(), timeout: GIT_TIMEOUT, killTree: true })).stdout.toString("utf8").trim();
    } catch (e) {
      throw err("git_failed", tidy(String((e as { stderr?: string }).stderr || (e as Error).message), MAX_ERROR));
    }
  };
  /** SHA of `ref` (default: the remote HEAD), trying the remote branch first, then a tag or SHA. */
  const resolveRef = async (cwd: string, ref: string | undefined): Promise<string> => {
    const tries = ref ? [`origin/${ref}`, ref] : ["origin/HEAD", "HEAD"];
    let last: unknown;
    for (const t of tries)
      try {
        return await git(cwd, ["rev-parse", "--verify", "--end-of-options", `${t}^{commit}`]);
      } catch (e) {
        last = e;
      }
    throw ref ? err("git_failed", `unknown ref "${redactUrls(ref)}"`) : last;
  };
  const get = (name: string) => {
    const r = store.get().addons[name];
    if (!r) throw err("not_found", `unknown addon ${name}`);
    return r;
  };
  const changed = (fn: (s: State) => void) => (store.change(fn), valid.clear(), syncWatch(), opts.onChanged());
  const info = (name: string) => {
    const r = get(name);
    const i = toInfo(name, r, dir, nonce, r.dev ? lastGood.get(name) : undefined, r.dev ? revs.get(name) : undefined);
    if (r.dev && i.manifest && !i.error) lastGood.set(name, i.manifest);
    // A manifest that now declares more than was approved never stays enabled.
    if (i.state === "needs_approval" && r.enabled) (store.change((s) => void (s.addons[name]!.enabled = false)), syncWatch());
    return i;
  };
  /** `load`, but in dev mode an addon.json that does not load right now falls back to the last good manifest (its approvals still cover it). */
  const loadDev = (root: string, name: string, r: Record_): ReturnType<typeof load> => {
    const l = load(root, name);
    if ("manifest" in l) return (r.dev && lastGood.set(name, l.manifest), l);
    const last = r.dev ? lastGood.get(name) : undefined;
    return last ? { manifest: last } : l;
  };

  const stopWatch = (name: string) => {
    const h = watchers.get(name);
    if (!h) return;
    watchers.delete(name);
    clearTimeout(h.timer);
    try {
      h.w.close();
    } catch {
      // already closed
    }
  };
  /** An edit settled in a dev addon's folder: re-read it. A capability declared and not approved disables the addon (syncWatch then closes the watcher; approving prompts like an update). Fewer or the same capabilities never prompt (plan: approvals stay while the declared set is a subset). */
  const edited = (name: string) => {
    const r = store.get().addons[name];
    if (!r?.dev) return;
    bump(name);
    const l = loadDev(rootOf(dir, name, r), name, r);
    if (!("manifest" in l) || covered(l.manifest, r.approved) || !r.enabled) return void (valid.clear(), opts.onChanged());
    changed((s) => void (s.addons[name]!.enabled = false));
  };
  const startWatch = (name: string, r: Record_) => {
    const root = rootOf(dir, name, r);
    loadDev(root, name, r);
    bump(name);
    try {
      const h: { w: { close(): void }; timer?: NodeJS.Timeout } = { w: { close() {} } };
      const w = watch(root, { recursive: true }, (_event, file) => {
        if (file !== null && file.split(/[\\/]/).some((x) => x === ".git" || x === "node_modules")) return;
        clearTimeout(h.timer);
        h.timer = setTimeout(() => ((h.timer = undefined), edited(name)), opts.devDebounceMs ?? DEV_DEBOUNCE_MS);
      });
      w.on("error", () => stopWatch(name)); // a vanished folder or a watcher limit: dev mode stops, the addon keeps working
      h.w = w;
      watchers.set(name, h);
    } catch {
      // cannot watch this folder (limit reached, no recursive support): the addon works without live reload
    }
  };
  /** One watcher per enabled dev addon, none for any other: called after every change of the records. */
  function syncWatch() {
    const want = new Set(Object.entries(store.get().addons).filter(([, r]) => r.dev && r.enabled && r.source.kind === "local").map(([n]) => n));
    for (const n of [...watchers.keys()]) if (!want.has(n)) stopWatch(n);
    for (const n of want) if (!watchers.has(n)) startWatch(n, store.get().addons[n]!);
  }
  syncWatch();
  const gitSource = (s: AddonSource) => {
    if (s.kind === "git") {
      if (typeof s.url !== "string" || s.url.trim() === "" || s.url.startsWith("-")) throw err("bad_request", "invalid git URL");
      if (s.ref !== undefined && (typeof s.ref !== "string" || s.ref.startsWith("-"))) throw err("bad_request", "invalid ref");
      if (s.path !== undefined && !subpathOk(s.path)) throw err("bad_request", "invalid addon path");
    }
  };

  async function install(source: AddonSource): Promise<AddonInfo> {
    if (!isObj(source) || (source.kind !== "git" && source.kind !== "local")) throw err("bad_request", "source must be git or local");
    gitSource(source);
    let name: string;
    let sha: string | undefined;
    let tmp: string | undefined;
    try {
      let manifest: AddonManifest;
      if (source.kind === "local") {
        if (typeof source.path !== "string" || !isAbsolute(source.path)) throw err("bad_request", "the folder must be an absolute path");
        const path = (() => {
          try {
            return realpathSync(source.path);
          } catch {
            throw err("not_found", `folder not found: ${source.path}`);
          }
        })();
        if (!statSync(path).isDirectory()) throw err("bad_request", `not a folder: ${source.path}`);
        mkdirSync(dir, { recursive: true });
        if (within(realpathSync(dir), path)) throw err("bad_request", "the folder lies inside the config dir");
        manifest = parseManifest(readJson(path), path);
        source = { kind: "local", path };
      } else {
        mkdirSync(join(dir, "addons"), { recursive: true });
        tmp = join(dir, "addons", `.tmp-${randomBytes(6).toString("hex")}`);
        await git(dir, ["clone", "--no-checkout", "--", source.url, tmp]);
        sha = await resolveRef(tmp, source.ref);
        await git(tmp, ["checkout", "--detach", sha]);
        const root = join(tmp, source.path ?? "");
        try {
          if (!within(realpathSync(tmp), realpathSync(root)) || !statSync(root).isDirectory()) throw 0;
        } catch {
          throw err("not_found", `folder not found in the repository: ${source.path ?? ""}`);
        }
        manifest = parseManifest(readJson(root), root);
        source = { kind: "git", url: source.url, ...(source.ref !== undefined && { ref: source.ref }), ...(source.path && { path: source.path }) };
      }
      name = manifest.name;
      if (store.get().addons[name]) throw err("exists", `addon "${name}" is already installed`);
      if (tmp) {
        const dest = join(dir, "addons", name);
        rmSync(dest, { recursive: true, force: true }); // a leftover of a removed record
        renameSync(tmp, dest);
        tmp = undefined;
      }
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }
    changed((s) => void (s.addons[name] = { source, ...(sha && { sha }), approved: [], enabled: false }));
    return info(name);
  }

  async function checkUpdate(name: string): Promise<AddonUpdateCheck> {
    const r = get(name);
    if (r.source.kind !== "git" || !r.sha) throw err("bad_request", "only git addons update");
    const checkout = join(dir, "addons", name);
    const root = rootOf(dir, name, r);
    await git(checkout, ["fetch", "--tags", "origin"]);
    const latest = await resolveRef(checkout, r.source.ref);
    checked.set(name, latest);
    let next: string[] = [];
    try {
      const sub = r.source.path ? `${r.source.path}/` : "";
      const raw = JSON.parse(await git(checkout, ["show", `${latest}:${sub}addon.json`])) as { capabilities?: unknown };
      next = Array.isArray(raw.capabilities) ? raw.capabilities.filter((c): c is string => typeof c === "string") : [];
    } catch (e) {
      return { name, current: r.sha, latest, added: [], removed: [], error: e instanceof ConfigError ? e.message : "addon.json of the new version is not valid JSON" };
    }
    const now = (load(root, name) as { manifest?: AddonManifest }).manifest?.capabilities ?? r.approved;
    return { name, current: r.sha, latest, added: next.filter((c) => !now.includes(c)), removed: now.filter((c) => !next.includes(c)) };
  }

  async function update(name: string, sha: unknown): Promise<AddonInfo> {
    const r = get(name);
    if (r.source.kind !== "git" || !r.sha) throw err("bad_request", "only git addons update");
    if (typeof sha !== "string" || sha !== checked.get(name)) throw err("bad_request", "update the version the last check showed");
    const checkout = join(dir, "addons", name);
    const root = rootOf(dir, name, r);
    await git(checkout, ["checkout", "--detach", sha]);
    const l = load(root, name);
    if ("error" in l) {
      await git(checkout, ["checkout", "--detach", r.sha]);
      throw bad(l.error);
    }
    changed((s) => {
      const x = s.addons[name]!;
      x.sha = sha;
      // Approvals of capabilities the new version no longer declares end: declaring one again later needs approval again.
      x.approved = x.approved.filter((c) => l.manifest.capabilities.includes(c));
      if (!covered(l.manifest, x.approved)) x.enabled = false;
    });
    checked.delete(name);
    return info(name);
  }

  /** The addon.json files of a repository (no install): one candidate per file, sorted by path. Files that are links, deeper than 3 folders, or under `.git` or `node_modules` are ignored. */
  async function discover(source: unknown): Promise<AddonCandidate[]> {
    if (!isObj(source) || source.kind !== "git") throw err("bad_request", "source must be git");
    gitSource(source as AddonSource);
    const s = source as { url: string; ref?: string };
    mkdirSync(join(dir, "addons"), { recursive: true });
    const tmp = join(dir, "addons", `.tmp-${randomBytes(6).toString("hex")}`);
    try {
      await git(dir, ["clone", "--no-checkout", "--", s.url, tmp]);
      const sha = await resolveRef(tmp, s.ref);
      const tree = await git(tmp, ["ls-tree", "-r", "-z", "--full-tree", sha]);
      const files: string[] = [];
      for (const e of tree.split("\0")) {
        const m = /^(\d{6}) blob [0-9a-f]+\t(.+)$/s.exec(e);
        if (!m || (m[1] !== "100644" && m[1] !== "100755")) continue;
        const p = m[2]!;
        if (p !== "addon.json" && !p.endsWith("/addon.json")) continue;
        const segs = p.split("/").slice(0, -1);
        if (segs.length > MAX_DEPTH || segs.some((x) => x === ".git" || x === "node_modules")) continue;
        files.push(segs.join("/"));
      }
      files.sort();
      const out: AddonCandidate[] = [];
      for (const path of files.slice(0, MAX_CANDIDATES)) {
        const c: AddonCandidate = { path, name: "", version: "", description: "" };
        try {
          const raw: unknown = JSON.parse(await git(tmp, ["show", `${sha}:${path ? `${path}/` : ""}addon.json`]));
          if (!isObj(raw)) throw new SyntaxError();
          if (typeof raw.name === "string" && NAME.test(raw.name) && typeof raw.version === "string" && raw.version !== "") {
            c.name = raw.name.slice(0, 64);
            c.version = raw.version.slice(0, 64);
            if (typeof raw.description === "string") c.description = raw.description.slice(0, 500);
          } else c.error = "addon.json has no valid name and version";
        } catch (e) {
          c.error = e instanceof SyntaxError ? "addon.json is not valid JSON" : "addon.json cannot be read";
        }
        out.push(c);
      }
      return out;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  function approve(name: string, caps: unknown): AddonInfo {
    const r = get(name);
    const l = load(rootOf(dir, name, r), name);
    if ("error" in l) throw err("bad_request", l.error);
    const want = [...declared(l.manifest)].sort();
    if (!Array.isArray(caps) || JSON.stringify([...caps].sort()) !== JSON.stringify(want)) throw err("bad_request", "approve exactly the declared capabilities");
    changed((s) => void Object.assign(s.addons[name]!, { approved: want, enabled: true }));
    return info(name);
  }

  function setEnabled(name: string, enabled: unknown): AddonInfo {
    if (typeof enabled !== "boolean") throw err("bad_request", "enabled must be a boolean");
    const i = info(name);
    if (enabled && i.state !== "enabled" && i.state !== "disabled") throw err("bad_request", i.state === "error" ? i.error ?? "the addon does not load" : "approve the capabilities first");
    changed((s) => void (s.addons[name]!.enabled = enabled));
    return info(name);
  }

  function setDev(name: string, dev: unknown): AddonInfo {
    if (typeof dev !== "boolean") throw err("bad_request", "dev must be a boolean");
    const r = get(name);
    if (r.source.kind !== "local") throw err("bad_request", "dev mode is for local folders");
    if (!dev) (lastGood.delete(name), revs.delete(name));
    changed((s) => (dev ? void (s.addons[name]!.dev = true) : void delete s.addons[name]!.dev));
    return info(name);
  }

  function uninstall(name: string): Record<string, never> {
    const r = get(name);
    if (r.source.kind === "git") rmSync(rootOf(dir, name, r), { recursive: true, force: true });
    checked.delete(name);
    lastGood.delete(name);
    revs.delete(name);
    changed((s) => {
      delete s.addons[name];
      for (const [t, n] of Object.entries(s.picks)) if (n === name) delete s.picks[t];
    });
    return {};
  }

  function pickRenderer(target: unknown, name: unknown): Record<string, never> {
    if (typeof target !== "string" || !/^(fence|tool):.+$/.test(target) || typeof name !== "string") throw err("bad_request", "target must be fence:<lang> or tool:<name>");
    const i = info(name);
    const claims = i.manifest?.renderers.some((x) => ("fence" in x ? `fence:${x.fence}` : `tool:${x.tool}`) === target);
    if (!claims) throw err("bad_request", `${name} does not claim ${target}`);
    changed((s) => void (s.picks[target] = name));
    return {};
  }

  async function handle(msg: AddonsRequest): Promise<unknown> {
    switch (msg.type) {
      case "addons.list": {
        const s = store.get();
        return { addons: Object.keys(s.addons).sort().map(info), picks: s.picks } satisfies AddonsListResult;
      }
      case "addons.install":
        return install(msg.source);
      case "addons.discover":
        return discover(msg.source);
      case "addons.checkUpdate":
        return checkUpdate(String(msg.name));
      case "addons.update":
        return update(String(msg.name), msg.sha);
      case "addons.approve":
        return approve(String(msg.name), msg.capabilities);
      case "addons.setEnabled":
        return setEnabled(String(msg.name), msg.enabled);
      case "addons.setDev":
        return setDev(String(msg.name), msg.dev);
      case "addons.uninstall":
        return uninstall(String(msg.name));
      case "addons.pickRenderer":
        return pickRenderer(msg.target, msg.name);
      default:
        throw err("bad_request", `unknown request ${String((msg as { type: unknown }).type)}`);
    }
  }

  /** The file of an enabled addon (a local folder is re-read: an edit that needs approval stops serving), else undefined. `net`: approved origins for connect-src. `theme` (query `?theme=<id>`): when it is a theme of this addon whose `css` is this file, `scope` is the root selector to scope the file under (addon-css.ts). */
  function serve(name: string, rest: string, theme?: string): { root: string; path: string; type: string; net: string[]; html: boolean; scope?: string } | undefined {
    const r = store.get().addons[name];
    if (!r) return undefined;
    const root = rootOf(dir, name, r);
    const f = addonFile(root, rest);
    if (!f) return undefined;
    const html = f.type.startsWith("text/html");
    // The manifest is validated when a page (an HTML entry) loads, not for every script, style and image it then asks for.
    if (html || !valid.has(name)) {
      const l = loadDev(root, name, r);
      const ok = !("error" in l) && r.enabled && covered(l.manifest, r.approved);
      ok ? valid.add(name) : valid.delete(name);
      if (!ok) return undefined;
    } else if (!r.enabled) return undefined;
    const scoped = theme !== undefined && !html && f.type.startsWith("text/css") && (() => {
      const l = loadDev(root, name, r);
      return "manifest" in l && l.manifest.themes.some((t) => t.id === theme && t.css === assetKey(rest));
    })();
    return { root, ...f, net: r.approved.filter((c) => c.startsWith("net:")).map((c) => c.slice(4)), html, ...(scoped && { scope: themeRoot(name, theme) }) };
  }

  /** Stops every watcher (daemon shutdown). */
  const close = () => [...watchers.keys()].forEach(stopWatch);

  return { handle, serve, nonce, close };
}

function readJson(root: string): unknown {
  try {
    return JSON.parse(readFileSync(join(root, "addon.json"), "utf8"));
  } catch (e) {
    throw bad((e as NodeJS.ErrnoException).code === "ENOENT" ? "addon.json not found" : "addon.json is not valid JSON");
  }
}
