// Addons (docs/spec.md "Addons"): install from a local bare git repo or a folder, approval, serving with the addon CSP, updates, redaction.
import { canSymlink, needsLinks } from "./symlink-support.ts";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { AddonCandidate, AddonInfo, AddonUpdateCheck, AddonsListResult, ServerMessage } from "@claude-ui/protocol";
import { TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL } from "@claude-ui/protocol";
import { createDaemon } from "../src/server.ts";
import { parseManifest, toInfo } from "../src/addons.ts";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "addons-")));
const webRoot = join(tmp, "web");
const addonsDir = join(tmp, "config");
const origin = join(tmp, "origin.git");
const work = join(tmp, "work");
mkdirSync(webRoot);
const token = "t0ken-for-tests_abcdefghijklmnopqrstuvwxyz0";
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

const BASE = { name: "example", version: "1.0.0", description: "d", capabilities: ["ui.pane"], views: [{ id: "stats", title: "Stats", entry: "pane.html", kind: "pane" }] };
const json = (v: unknown) => JSON.stringify(v);
/** Replaces addon.json of the work clone with BASE + patch (an undefined value removes the key), commits and pushes; the new SHA. */
function commitAddon(patch: Record<string, unknown> = {}): string {
  writeFileSync(join(work, "addon.json"), json({ ...BASE, ...patch }));
  writeFileSync(join(work, "pane.html"), '<script src="pane.js"></script>');
  writeFileSync(join(work, "pane.js"), "");
  git(work, "add", "-A");
  git(work, "commit", "-q", "--allow-empty", "-m", "c");
  git(work, "push", "-q", "origin", "HEAD:main");
  return git(work, "rev-parse", "HEAD");
}
/** A local-folder addon. */
function folder(name: string, patch: Record<string, unknown> = {}): string {
  const d = join(tmp, `folder-${name}`);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "addon.json"), json({ ...BASE, name, ...patch }));
  for (const f of ["pane.html", "band.html", "r.html"]) writeFileSync(join(d, f), "<p>x</p>");
  return d;
}

let first: string;
beforeAll(() => {
  git(tmp, "init", "-q", "--bare", "-b", "main", origin);
  git(tmp, "init", "-q", "-b", "main", work);
  git(work, "remote", "add", "origin", origin);
  first = commitAddon();
  git(work, "tag", "v1");
  git(work, "push", "-q", "origin", "v1");
  // About ten git processes (0.44 s each on Windows when idle, over the 10 s default in a full suite).
}, process.platform === "win32" ? 60_000 : undefined);

const http = createDaemon({ webRoot, roots: [webRoot], token, addonsDir });
await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
const { port } = http.address() as AddressInfo;
afterAll(() => void http.close());

function client(p = port) {
  const ws = new WebSocket(`ws://127.0.0.1:${p}/ws`, [WS_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${token}`], { origin: `http://127.0.0.1:${p}` });
  const inbox: ServerMessage[] = [];
  ws.on("message", (d) => inbox.push(JSON.parse(String(d))));
  const waitFor = (pred: (m: ServerMessage) => boolean) =>
    new Promise<ServerMessage>((resolve) => {
      const t = setInterval(() => {
        const m = inbox.find(pred);
        if (m) clearInterval(t), resolve(m);
      }, 5);
    });
  const request = async (msg: object) => {
    const reqId = Math.random().toString(36);
    ws.send(JSON.stringify({ ...msg, reqId }));
    return (await waitFor((m) => (m.type === "reply" || m.type === "error") && m.reqId === reqId)) as { type: string; result?: any; code?: string; message?: string };
  };
  return new Promise<{ ws: WebSocket; request: typeof request; inbox: ServerMessage[]; waitFor: typeof waitFor }>((resolve) => ws.once("open", () => resolve({ ws, request, inbox, waitFor })));
}
const c = await client();
const list = async () => (await c.request({ type: "addons.list" })).result as AddonsListResult;
const installGit = async (ref?: string) => c.request({ type: "addons.install", source: { kind: "git", url: origin, ...(ref && { ref }) } });
const approveAll = async (name: string) => {
  const i = ((await list()).addons.find((a) => a.name === name) as AddonInfo).manifest!;
  return (await c.request({ type: "addons.approve", name, capabilities: i.capabilities })).result as AddonInfo;
};
/** GET with explicit Sec-Fetch-Dest (fetch may not set it). */
const fetchAddon = (path: string, dest = "iframe") =>
  new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) =>
    httpGet({ host: "127.0.0.1", port, path, headers: { "sec-fetch-dest": dest } }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    }).on("error", reject),
  );

beforeEach(async () => {
  for (const a of (await list()).addons) await c.request({ type: "addons.uninstall", name: a.name });
});

describe("addons.install", () => {
  it("from git pins the SHA of HEAD", async () => {
    const head = commitAddon();
    const r = await installGit();
    expect(r.result).toMatchObject({ name: "example", state: "needs_approval", sha: head, approved: [], source: { kind: "git", url: origin } });
    expect(existsSync(join(addonsDir, "addons/example/addon.json"))).toBe(true);
    await c.waitFor((m) => m.type === "config.changed" && m.kind === "addons" && m.cwd === "");
  });

  it("a ref resolves to its SHA", async () => {
    commitAddon();
    const r = await installGit("v1");
    expect((r.result as AddonInfo).sha).toBe(first);
  });

  it("refuses an invalid manifest and leaves no folder", async () => {
    commitAddon({ name: undefined });
    const r = await installGit();
    expect(r).toMatchObject({ type: "error", code: "bad_manifest" });
    expect(r.message).toContain("name");
    expect(readdirSync(join(addonsDir, "addons")).filter((f) => f.startsWith(".tmp-") || f === "example")).toEqual([]);
    expect((await list()).addons).toEqual([]);
  });

  it("refuses an entry no capability covers", async () => {
    commitAddon({ capabilities: [] });
    expect((await installGit()).message).toContain("views[stats] needs capability ui.pane");
    commitAddon({ commands: [{ name: "cmd", description: "d" }] });
    expect((await installGit()).message).toContain("commands[cmd] needs capability ui.command");
    commitAddon({ renderers: [{ fence: "x", entry: "pane.html" }] });
    expect((await installGit()).message).toContain("renderers[fence x] needs capability render.fence:x");
  });

  it("refuses an unknown capability, a path outside the addon and a malformed net origin", async () => {
    commitAddon({ capabilities: ["ui.pane", "shell.run"] });
    expect((await installGit()).message).toContain('invalid capability "shell.run"');
    commitAddon({ views: [{ id: "stats", title: "S", entry: "../x.html", kind: "pane" }] });
    expect(await installGit()).toMatchObject({ code: "bad_manifest" });
    commitAddon({ capabilities: ["ui.pane", "net:https://api.github.com/path"] });
    expect(await installGit()).toMatchObject({ code: "bad_manifest" });
  });

  it("refuses a theme colour that is not a colour", async () => {
    commitAddon({ themes: [{ id: "dusk", name: "Dusk", dark: { bg: "red;}body{x" } }] });
    expect(await installGit()).toMatchObject({ type: "error", code: "bad_manifest" });
  });

  it("refuses a second install of the same name", async () => {
    commitAddon();
    await installGit();
    expect(await installGit()).toMatchObject({ code: "exists" });
  });
});

describe("repository with addons in subfolders", () => {
  const multi = join(tmp, "multi.git");
  const mwork = join(tmp, "multi-work");
  const put = (rel: string, content: string) => {
    mkdirSync(join(mwork, rel, ".."), { recursive: true });
    writeFileSync(join(mwork, rel), content);
  };
  const manifest = (name: string, patch: Record<string, unknown> = {}) => json({ ...BASE, name, ...patch });
  const push = () => {
    git(mwork, "add", "-A");
    git(mwork, "commit", "-q", "--allow-empty", "-m", "c");
    git(mwork, "push", "-q", "origin", "HEAD:main");
    return git(mwork, "rev-parse", "HEAD");
  };
  const discover = async (extra: object = {}) => c.request({ type: "addons.discover", source: { kind: "git", url: multi, ...extra } });
  const installAt = (path: string) => c.request({ type: "addons.install", source: { kind: "git", url: multi, path } });
  beforeAll(() => {
    git(tmp, "init", "-q", "--bare", "-b", "main", multi);
    git(tmp, "init", "-q", "-b", "main", mwork);
    git(mwork, "remote", "add", "origin", multi);
    for (const d of ["alpha", "packs/beta"]) {
      put(`${d}/addon.json`, manifest(d.split("/").pop()!));
      put(`${d}/pane.html`, "<p>x</p>");
    }
    put("broken/addon.json", "{not json");
    put("a/b/c/d/deep/addon.json", manifest("deep")); // 4 folders deep
    put("node_modules/dep/addon.json", manifest("dep"));
    mkdirSync(join(tmp, "folder-outside"), { recursive: true });
    writeFileSync(join(tmp, "folder-outside/addon.json"), manifest("outside"));
    writeFileSync(join(tmp, "folder-outside/pane.html"), "x");
    if (canSymlink) {
      mkdirSync(join(mwork, "links"), { recursive: true });
      symlinkSync("../alpha/addon.json", join(mwork, "links/addon.json"));
      symlinkSync(join(tmp, "folder-outside"), join(mwork, "escape"));
    }
    push();
  }, process.platform === "win32" ? 60_000 : undefined);

  it("discover lists addon.json files sorted, flags a broken one, and skips deep folders, node_modules and links", async () => {
    const r = (await discover()).result as AddonCandidate[];
    expect(r.map((x) => x.path)).toEqual(["alpha", "broken", "packs/beta"]);
    expect(r[0]).toMatchObject({ name: "alpha", version: "1.0.0", description: "d" });
    expect(r[1]).toMatchObject({ error: "addon.json is not valid JSON" });
    expect(readdirSync(join(addonsDir, "addons")).filter((n) => n.startsWith(".tmp-"))).toEqual([]);
  });

  it("installs the addon of a subfolder, pins the SHA, stores the path and keeps one checkout per addon", async () => {
    const head = git(mwork, "rev-parse", "HEAD");
    const r = await installAt("packs/beta");
    expect(r.result).toMatchObject({ name: "beta", state: "needs_approval", sha: head, source: { kind: "git", url: multi, path: "packs/beta" } });
    const i = await approveAll("beta");
    expect(i.state).toBe("enabled");
    expect((await fetchAddon(`${i.base}pane.html`)).status).toBe(200);
    expect((await installAt("alpha")).result).toMatchObject({ name: "alpha" });
    expect(existsSync(join(addonsDir, "addons/alpha/alpha/addon.json"))).toBe(true);
  });

  it("the repository root without addon.json stays 'addon.json not found'; a missing subfolder is not_found", async () => {
    expect(await c.request({ type: "addons.install", source: { kind: "git", url: multi } })).toMatchObject({ type: "error", message: "addon.json not found" });
    expect(await installAt("nope")).toMatchObject({ type: "error", code: "not_found" });
  });

  it("checkUpdate reads addon.json of the subfolder", async () => {
    await installAt("packs/beta");
    await approveAll("beta");
    put("packs/beta/addon.json", manifest("beta", { capabilities: ["ui.pane", "ui.toast"] }));
    const next = push();
    const r = (await c.request({ type: "addons.checkUpdate", name: "beta" })).result as AddonUpdateCheck;
    expect(r).toMatchObject({ latest: next, added: ["ui.toast"], removed: [] });
  });

  it.skipIf(!canSymlink)(needsLinks("a subfolder that is a link out of the repository is refused"), async () => {
    expect(await installAt("escape")).toMatchObject({ type: "error", code: "not_found" });
    expect((await list()).addons).toEqual([]);
  });

  it.each(["../x", "/etc", "a//b", "./a", "a/../b", "a\\b", "a/b/c/d", "-x", ".git", "a/.git"])("refuses the path %s", async (path) => {
    expect(await installAt(path)).toMatchObject({ type: "error", code: "bad_request" });
  });
});

describe("serving", () => {
  it("approve enables; the file is served with the addon CSP", async () => {
    commitAddon({ capabilities: ["ui.pane", "net:https://api.github.com"] });
    await installGit();
    const i = await approveAll("example");
    expect(i.state).toBe("enabled");
    expect(i.base).toMatch(/^\/addon\/[0-9a-f]{32}\/example\/$/);
    const r = await fetchAddon(i.base + "pane.html");
    const csp = String(r.headers["content-security-policy"]);
    expect(r.status).toBe(200);
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain(`script-src http://127.0.0.1:${port}${i.base}`);
    expect(csp).toContain("connect-src https://api.github.com;");
    expect((await fetchAddon(i.base + "pane.js", "script")).status).toBe(200);
    expect((await fetchAddon(i.base + "pane.html", "script")).status).toBe(403); // a page only as a frame
  });

  describe("theme css", () => {
    const palette = Object.fromEntries(["bg", "card", "side", "fg", "muted", "border", "primary", "pfg", "kw", "str", "fn", "type", "num", "cmt", "varc", "err", "warn", "ok", "info"].map((k) => [k, "#101010"]));
    /** A local addon with two themes, one css file each. */
    const themed = async (css: Record<string, string>) => {
      const d = folder("themed", { themes: [{ id: "dusk", name: "Dusk", dark: palette, css: "dusk.css" }, { id: "dawn", name: "Dawn", dark: palette, css: "dawn.css" }] });
      for (const [f, text] of Object.entries(css)) writeFileSync(join(d, f), text);
      await c.request({ type: "addons.install", source: { kind: "local", path: d } });
      return (await approveAll("themed")).base!;
    };

    it("a theme's css is served scoped to that theme, so its :root and .dark rules cannot reach another theme", async () => {
      const base = await themed({ "dusk.css": ":root { --background: #111 } .dark { --card: #222 }", "dawn.css": ".a { color: red }" });
      const r = await fetchAddon(`${base}dusk.css?theme=dusk`, "style");
      expect(r.status).toBe(200);
      expect(String(r.headers["content-type"])).toContain("text/css");
      expect(r.body).toContain(':root[data-theme="addon:themed:dusk"] {');
      expect(r.body.replace(/\s+/g, " ")).toContain("& { --background: #111 } &.dark { --card: #222 }");
    });

    it("lint warns about a test-hook selector and never blocks the install; an edit clears it on the next list", async () => {
      const d = folder("linted", { themes: [{ id: "dusk", name: "Dusk", dark: palette, css: "dusk.css" }], css: "legacy.css" });
      writeFileSync(join(d, "dusk.css"), '[data-testid="sidebar"] { color: red } @keyframes spin {}');
      writeFileSync(join(d, "legacy.css"), "a {}");
      const i = (await c.request({ type: "addons.install", source: { kind: "local", path: d } })).result as AddonInfo;
      expect(i.state).toBe("needs_approval"); // installed
      expect(i.lint?.map((l) => `${l.code}:${l.file}`)).toEqual(["top-level-css:legacy.css", "selects-testid:dusk.css", "unprefixed-name:dusk.css"]);
      expect((await list()).addons.find((a) => a.name === "linted")?.lint).toHaveLength(3);
      writeFileSync(join(d, "dusk.css"), '[data-part="sidebar"] { color: red }');
      writeFileSync(join(d, "addon.json"), json({ ...BASE, name: "linted", themes: [{ id: "dusk", name: "Dusk", dark: palette, css: "dusk.css" }] }));
      const again = (await list()).addons.find((a) => a.name === "linted")!;
      expect(again.lint).toBeUndefined();
    });

    it("the same file without ?theme, or with the other theme's id, is served as it is", async () => {
      const base = await themed({ "dusk.css": ":root { --background: #111 }", "dawn.css": ".a { color: red }" });
      expect((await fetchAddon(`${base}dusk.css`, "style")).body).toBe(":root { --background: #111 }");
      expect((await fetchAddon(`${base}dusk.css?theme=dawn`, "style")).body).toBe(":root { --background: #111 }");
    });

    it("broken css is served unscoped and never fails the request", async () => {
      const base = await themed({ "dusk.css": ".a { color: red", "dawn.css": "" });
      const r = await fetchAddon(`${base}dusk.css?theme=dusk`, "style");
      expect(r.status).toBe(200);
      expect(r.body).toBe(".a { color: red");
    });

    it("a file over the size cap reaches the client as it is; HEAD answers with the headers only", async () => {
      const big = ":root { --a: 1 }" + " ".repeat(512 * 1024);
      const base = await themed({ "dusk.css": big, "dawn.css": "" });
      const r = await fetchAddon(`${base}dusk.css?theme=dusk`, "style");
      expect(r.status).toBe(200);
      expect(r.body).toBe(big);
      const head = await new Promise<{ status: number; len: string | undefined; body: string }>((resolve, reject) =>
        httpGet({ host: "127.0.0.1", port, method: "HEAD", path: `${base}dusk.css?theme=dusk`, headers: { "sec-fetch-dest": "style" } }, (res) => {
          let body = "";
          res.on("data", (d) => (body += d));
          res.on("end", () => resolve({ status: res.statusCode!, len: res.headers["content-length"], body }));
        }).on("error", reject),
      );
      expect(head).toEqual({ status: 200, len: String(big.length), body: "" });
    });

    it("an edit of the file shows on the next request", async () => {
      const base = await themed({ "dusk.css": ".a { x: 1 }", "dawn.css": "" });
      expect((await fetchAddon(`${base}dusk.css?theme=dusk`, "style")).body).toContain(".a { x: 1 }");
      writeFileSync(join(tmp, "folder-themed", "dusk.css"), ".b { y: 22 }");
      expect((await fetchAddon(`${base}dusk.css?theme=dusk`, "style")).body).toContain(".b { y: 22 }");
    });

    it.each([["a missing file", { themes: [{ id: "dusk", name: "D", dark: palette, css: "nope.css" }] }], ["a file that is not css", { themes: [{ id: "dusk", name: "D", dark: palette, css: "pane.html" }] }]])("the manifest refuses %s", (_n, patch) => {
      expect(() => parseManifest({ ...BASE, ...patch }, folder("bad", patch))).toThrow(/themes\[dusk\]\.css/);
    });
  });

  it("without net: connect-src is none", async () => {
    commitAddon();
    await installGit();
    const i = await approveAll("example");
    expect(String((await fetchAddon(i.base + "pane.html")).headers["content-security-policy"])).toContain("connect-src 'none'");
  });

  it("a disabled addon's files are not served", async () => {
    commitAddon();
    await installGit();
    const i = await approveAll("example");
    const off = (await c.request({ type: "addons.setEnabled", name: "example", enabled: false })).result as AddonInfo;
    expect(off.base).toBeUndefined();
    expect((await fetchAddon(i.base + "pane.html")).status).toBe(404);
    expect(((await list()).addons[0] as AddonInfo).base).toBeUndefined();
  });

  it("a wrong nonce or a path outside the root is 404", async () => {
    commitAddon();
    await installGit();
    const i = await approveAll("example");
    expect((await fetchAddon(`/addon/${"0".repeat(32)}/example/pane.html`)).status).toBe(404);
    expect((await fetchAddon(i.base + "..%2faddon.json")).status).toBe(404);
    expect((await fetchAddon(i.base + ".git/config", "script")).status).toBe(404);
  });

  it.skipIf(!canSymlink)(needsLinks("a link inside the add-on that leads out of it is 404"), async () => {
    commitAddon();
    await installGit();
    const i = await approveAll("example");
    symlinkSync("/etc/hosts", join(addonsDir, "addons/example/hosts.json"));
    expect((await fetchAddon(i.base + "hosts.json", "script")).status).toBe(404);
    expect((await fetchAddon(i.base + ".git/config", "script")).status).toBe(404);
  });

  it("enabling needs the capabilities approved first", async () => {
    commitAddon();
    await installGit();
    expect(await c.request({ type: "addons.setEnabled", name: "example", enabled: true })).toMatchObject({ code: "bad_request" });
    expect(await c.request({ type: "addons.approve", name: "example", capabilities: [] })).toMatchObject({ code: "bad_request" });
  });
});

describe("updates", () => {
  it("checkUpdate shows the new commit and the capability diff", async () => {
    commitAddon();
    await installGit();
    await approveAll("example");
    const next = commitAddon({ capabilities: ["ui.pane", "ui.toast"] });
    const r = (await c.request({ type: "addons.checkUpdate", name: "example" })).result as AddonUpdateCheck;
    expect(r).toMatchObject({ latest: next, added: ["ui.toast"], removed: [] });
  });

  it("an update with a new capability leaves the addon disabled until approved", async () => {
    commitAddon();
    await installGit();
    const i = await approveAll("example");
    const next = commitAddon({ capabilities: ["ui.pane", "ui.toast"] });
    await c.request({ type: "addons.checkUpdate", name: "example" });
    const u = (await c.request({ type: "addons.update", name: "example", sha: next })).result as AddonInfo;
    expect(u).toMatchObject({ state: "needs_approval", sha: next });
    expect(u.base).toBeUndefined();
    expect((await fetchAddon(i.base + "pane.html")).status).toBe(404);
    expect((await approveAll("example")).state).toBe("enabled");
  });

  it("an update without new capabilities stays enabled", async () => {
    commitAddon();
    await installGit();
    await approveAll("example");
    const next = commitAddon({ version: "1.1.0" });
    await c.request({ type: "addons.checkUpdate", name: "example" });
    expect((await c.request({ type: "addons.update", name: "example", sha: next })).result).toMatchObject({ state: "enabled", sha: next, manifest: { version: "1.1.0" } });
  });

  it("refuses a sha the check did not show", async () => {
    commitAddon();
    await installGit();
    expect(await c.request({ type: "addons.update", name: "example", sha: first })).toMatchObject({ code: "bad_request" });
    commitAddon();
    await c.request({ type: "addons.checkUpdate", name: "example" });
    expect(await c.request({ type: "addons.update", name: "example", sha: first })).toMatchObject({ code: "bad_request" });
  });

  it("an update that renames the addon is refused and the checkout stays", async () => {
    const head = commitAddon();
    await installGit();
    const next = commitAddon({ name: "other" });
    await c.request({ type: "addons.checkUpdate", name: "example" });
    expect(await c.request({ type: "addons.update", name: "example", sha: next })).toMatchObject({ code: "bad_manifest" });
    expect(((await list()).addons[0] as AddonInfo).sha).toBe(head);
  });
});

describe("review fixes (GH-516)", () => {
  it("an update drops the approvals of capabilities the new version no longer declares; declaring one again needs approval", async () => {
    commitAddon({ capabilities: ["ui.pane", "ui.toast"] });
    await installGit();
    await approveAll("example");
    const v2 = commitAddon({ capabilities: ["ui.pane"] });
    await c.request({ type: "addons.checkUpdate", name: "example" });
    expect((await c.request({ type: "addons.update", name: "example", sha: v2 })).result).toMatchObject({ state: "enabled", approved: ["ui.pane"] });
    const v3 = commitAddon({ capabilities: ["ui.pane", "ui.toast"] });
    await c.request({ type: "addons.checkUpdate", name: "example" });
    const u = (await c.request({ type: "addons.update", name: "example", sha: v3 })).result as AddonInfo;
    expect(u.state).toBe("needs_approval");
    expect(u.base).toBeUndefined();
  });

  it("validates theme options: up to 4, unique kebab ids up to 24, label 1-40, boolean default", async () => {
    const o = { id: "rain", label: "Rain" };
    const all = Object.fromEntries(["bg", "card", "side", "fg", "muted", "border", "primary", "pfg", "kw", "str", "fn", "type", "num", "cmt", "varc", "err", "warn", "ok", "info"].map((k) => [k, "#112233"]));
    const theme = (options: unknown) => commitAddon({ themes: [{ id: "dusk", name: "D", dark: all, options }] });
    for (const bad of [[{ ...o, id: "Rain" }], [{ ...o, id: "a".repeat(25) }], [{ ...o, label: "" }], [{ ...o, label: "x".repeat(41) }], [{ ...o, default: "yes" }], [o, o], Array.from({ length: 5 }, (_, i) => ({ ...o, id: `o${i}` })), "rain"]) {
      theme(bad);
      expect(await installGit(), JSON.stringify(bad)).toMatchObject({ code: "bad_manifest" });
    }
    theme([o, { id: "glow", label: "Glow", default: false }]);
    expect(await installGit()).toMatchObject({ type: "reply" });
  });

  it("refuses a theme mode that lacks a palette key or uses a colour the web app would drop", async () => {
    const all = Object.fromEntries(["bg", "card", "side", "fg", "muted", "border", "primary", "pfg", "kw", "str", "fn", "type", "num", "cmt", "varc", "err", "warn", "ok", "info"].map((k) => [k, "#112233"]));
    const { info: _, ...short } = all;
    commitAddon({ themes: [{ id: "dusk", name: "D", dark: short }] });
    expect((await installGit()).message).toContain("missing info");
    commitAddon({ themes: [{ id: "dusk", name: "D", dark: { ...all, fg: "rgb(1, 2, 3)" } }] });
    expect(await installGit()).toMatchObject({ code: "bad_manifest" });
    commitAddon({ themes: [{ id: "dusk", name: "D", dark: all }] });
    expect(await installGit()).toMatchObject({ type: "reply" });
  });

  it("an edit of a local folder that needs approval stops its assets too, after the next page request", async () => {
    const d = folder("cache");
    await c.request({ type: "addons.install", source: { kind: "local", path: d } });
    const i = await approveAll("cache");
    expect((await fetchAddon(i.base + "pane.html")).status).toBe(200);
    expect((await fetchAddon(i.base + "pane.js", "script")).status).toBe(404); // folder() writes no pane.js
    writeFileSync(join(d, "pane.js"), "");
    expect((await fetchAddon(i.base + "pane.js", "script")).status).toBe(200);
    writeFileSync(join(d, "addon.json"), json({ ...BASE, name: "cache", capabilities: ["ui.pane", "ui.band"], views: [...BASE.views, { id: "b", title: "B", entry: "band.html", kind: "band" }] }));
    expect((await fetchAddon(i.base + "pane.html")).status).toBe(404);
    expect((await fetchAddon(i.base + "pane.js", "script")).status).toBe(404);
  });
});

describe("local folders, uninstall, renderer picks", () => {
  it("a local folder is re-read on list; a new capability needs approval", async () => {
    const d = folder("loc");
    expect((await c.request({ type: "addons.install", source: { kind: "local", path: d } })).result).toMatchObject({ name: "loc", state: "needs_approval" });
    const i = await approveAll("loc");
    expect(i.state).toBe("enabled");
    writeFileSync(join(d, "addon.json"), json({ ...BASE, name: "loc", capabilities: ["ui.pane", "ui.band"], views: [...BASE.views, { id: "b", title: "B", entry: "band.html", kind: "band" }] }));
    expect(((await list()).addons[0] as AddonInfo).state).toBe("needs_approval");
    expect((await fetchAddon(i.base + "pane.html")).status).toBe(404);
  });

  it("a local folder that is gone shows an error row; a relative path and the config dir are refused", async () => {
    const d = folder("gone");
    await c.request({ type: "addons.install", source: { kind: "local", path: d } });
    writeFileSync(join(d, "addon.json"), "{");
    expect(((await list()).addons[0] as AddonInfo)).toMatchObject({ state: "error", error: "addon.json is not valid JSON" });
    expect(await c.request({ type: "addons.install", source: { kind: "local", path: "rel/dir" } })).toMatchObject({ code: "bad_request" });
    expect(await c.request({ type: "addons.install", source: { kind: "local", path: addonsDir } })).toMatchObject({ code: "bad_request" });
  });

  it("uninstall removes the record and the checkout", async () => {
    commitAddon();
    await installGit();
    expect((await c.request({ type: "addons.uninstall", name: "example" })).result).toEqual({});
    expect(existsSync(join(addonsDir, "addons/example"))).toBe(false);
    expect((await list()).addons).toEqual([]);
  });

  it("pickRenderer stores the pick", async () => {
    const claim = { capabilities: ["render.fence:example"], views: [], renderers: [{ fence: "example", entry: "r.html" }] };
    for (const n of ["a", "b"]) await c.request({ type: "addons.install", source: { kind: "local", path: folder(n, claim) } });
    await c.request({ type: "addons.install", source: { kind: "local", path: folder("c") } });
    expect((await c.request({ type: "addons.pickRenderer", target: "fence:example", name: "b" })).result).toEqual({});
    expect((await list()).picks).toEqual({ "fence:example": "b" });
    expect(await c.request({ type: "addons.pickRenderer", target: "fence:example", name: "c" })).toMatchObject({ code: "bad_request" });
    await c.request({ type: "addons.uninstall", name: "b" });
    expect((await list()).picks).toEqual({});
  });
});

describe("the example addon", () => {
  it("has a valid manifest that no capability leaves uncovered", () => {
    const root = join(import.meta.dirname, "../../../examples/addons/example");
    const m = parseManifest(JSON.parse(readFileSync(join(root, "addon.json"), "utf8")), root);
    expect(m.capabilities).toHaveLength(11);
    expect(m.themes[0]!.dark).toHaveProperty("bg");
  });
});

describe("redaction and routing", () => {
  it("a git URL with a password is redacted in errors", async () => {
    const r = await c.request({ type: "addons.install", source: { kind: "git", url: "http://alice:secret@127.0.0.1:1/nope.git" } });
    expect(r).toMatchObject({ type: "error", code: "git_failed" });
    expect(r.message).not.toContain("secret");
  });

  it("toInfo of a stored record drops userinfo of the URL", () => {
    expect(toInfo("r", { source: { kind: "git", url: "https://alice:secret@example.com/r.git" }, approved: [], enabled: false }, addonsDir).source).toEqual({ kind: "git", url: "https://example.com/r.git" });
  });

  it("addons.* to a daemon without addonsDir fails addons_unavailable", async () => {
    const h = createDaemon({ webRoot, roots: [webRoot], token });
    await new Promise<void>((r) => h.listen(0, "127.0.0.1", r));
    const c2 = await client((h.address() as AddressInfo).port);
    expect(await c2.request({ type: "addons.list" })).toMatchObject({ type: "error", code: "addons_unavailable" });
    c2.ws.close();
    h.close();
  });
});
