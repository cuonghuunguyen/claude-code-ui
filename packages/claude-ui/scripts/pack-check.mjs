// Proves the package: npm pack, install the tarball in a temp dir, run --version / --help, start it on a free port,
// GET / (200) and open a WebSocket with the pairing token. Needs the npm registry (installs the runtime dependencies).
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "../package.json" with { type: "json" };

const pkgDir = fileURLToPath(new URL("..", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "claude-ui-pack-"));
// Windows: npm and the bin are .cmd shims, which only start through a shell.
// A shell joins the arguments with spaces and no quoting: quote the ones with spaces (C:\Users\First Last\...).
const shell = process.platform === "win32";
const q = (a) => (shell && /\s/.test(a) ? `"${a}"` : a);
const run = (cmd, args, cwd) => execFileSync(q(cmd), args.map(q), { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], shell });
const step = (m) => console.log(`\n== ${m}`);
const assert = (ok, m) => {
  if (!ok) throw new Error(m);
  console.log(`ok: ${m}`);
};
const freePort = () =>
  new Promise((res) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });

let child;
try {
  step("build + npm pack");
  run("npm", ["run", "build"], pkgDir);
  const tarball = run("npm", ["pack", "--ignore-scripts", "--pack-destination", tmp, "--json"], pkgDir);
  const files = JSON.parse(tarball)[0].files.map((f) => f.path);
  console.log(files.filter((f) => !f.startsWith("dist/web/assets/")).join("\n"), `\n(${files.length} files)`);
  assert(files.every((f) => /^(dist\/|package\.json$|THIRD_PARTY_NOTICES\.md$)/.test(f)), "tarball holds only dist/, package.json, notices (no tests, sources, dev-docs)");
  assert(files.includes("dist/cli.js") && files.includes("dist/web/index.html"), "tarball holds dist/cli.js and dist/web/index.html");

  step("npm install <tarball> in a temp dir");
  const app = join(tmp, "app");
  mkdirSync(app);
  writeFileSync(join(app, "package.json"), "{}");
  run("npm", ["install", "--no-audit", "--no-fund", join(tmp, readdirSync(tmp).find((f) => f.endsWith(".tgz")))], app);
  const bin = join(app, "node_modules", ".bin", shell ? "claude-ui.cmd" : "claude-ui");

  step("claude-ui --version / --help");
  const version = run(bin, ["--version"], app).trim();
  assert(version === pkg.version, `--version prints ${pkg.version} (got ${version})`);
  const help = run(bin, ["--help"], app);
  assert(["--port", "--roots", "--hostname", "--allow-bypass"].every((f) => help.includes(f)), "--help lists port, roots, hostname, allow-bypass");
  assert(!readdirSync(join(app, "node_modules")).some((d) => ["typescript", "tsx", "vite"].includes(d)), "no typescript, tsx or vite installed");

  const appRequire = createRequire(join(app, "x.js"));
  assert(typeof appRequire("node-pty").spawn === "function", "node-pty loads (prebuild or compiled)");
  const sdkBin = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  assert([sdkBin, `${sdkBin}-musl`].some((n) => { try { return appRequire.resolve(`${n}/package.json`); } catch { return false; } }), "the Agent SDK's Claude Code binary package is installed");

  step("start, GET /, WebSocket with token");
  const port = await freePort();
  const out = [];
  child = spawn(q(bin), ["--port", String(port)], { cwd: app, env: { ...process.env, XDG_CONFIG_HOME: join(tmp, "config") }, shell });
  child.stdout.on("data", (d) => out.push(String(d)));
  child.stderr.on("data", (d) => out.push(String(d)));
  const token = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`no pairing URL in 20 s:\n${out.join("")}`)), 20_000);
    child.stdout.on("data", () => {
      const m = out.join("").match(/#token=([\w-]+)/);
      if (m) (clearTimeout(t), res(m[1]));
    });
    child.on("exit", (c) => rej(new Error(`exited ${c}:\n${out.join("")}`)));
  });
  const origin = `http://127.0.0.1:${port}`;
  const page = await fetch(origin + "/");
  assert(page.status === 200 && (await page.text()).includes("<div id=\"root\">"), "GET / is 200 and serves the web app");
  const { WebSocket } = appRequire("ws");
  const protocol = await new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["claude-ui", `token.${token}`], { origin });
    ws.on("open", () => (res(ws.protocol), ws.close()));
    ws.on("error", rej);
  });
  assert(protocol === "claude-ui", "WebSocket /ws opens with the pairing token");
  console.log("\nPACK CHECK PASSED");
} finally {
  // The shell's kill would leave the daemon running on Windows: end the whole tree.
  if (child && shell) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child?.kill();
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch (e) {
    // Windows: the killed processes may still hold the folder (EBUSY); a left temp dir does not fail the check.
    console.warn(`could not remove ${tmp}: ${e.code}`);
  }
}
