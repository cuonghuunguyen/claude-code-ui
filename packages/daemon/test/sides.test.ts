import { execFileSync, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL, type PushPayload, type ServerMessage } from "@claude-ui/protocol";
import { createProjects } from "../src/projects.ts";
import { createSettings } from "../src/settings.ts";
import { createDaemon } from "../src/server.ts";
import { createRouter, createSides, dockerExecArgs, dockerSide, parseDistros, runSide, setupMessage, setupScript, wslArgs, wslSide, type SideProcess } from "../src/sides.ts";
import { fakeQuery } from "./fake-query.ts";

const dir = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const webRoot = dir("web-");
writeFileSync(join(webRoot, "index.html"), "<h1>app</h1>");
const winRoot = dir("win-");
const wslRoot = dir("wsl-");
const sideSession = "5d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6";
const token = "t0ken-for-tests_abcdefghijklmnopqrstuvwxyz0";

/** A side daemon in this process, wired like `wsl.exe ... claude-ui --side`. */
function inProcessSide(root = wslRoot, session = sideSession, onDaemon?: (d: ReturnType<typeof createDaemon>) => void): SideProcess {
  const side = createDaemon({
    webRoot,
    token: "",
    roots: [root],
    appSettings: createSettings(),
    query: fakeQuery as never,
    projects: createProjects(),
    history: {
      listSessions: (async () => [{ sessionId: session, cwd: root, summary: "side work", lastModified: 1000 }]) as never,
      getSessionInfo: (async (id: string) => (id === session ? { sessionId: id, cwd: root } : undefined)) as never,
      getSessionMessages: (async () => []) as never,
    },
  });
  onDaemon?.(side);
  const stdin = new PassThrough();
  stdin.on("data", (d) => void sideFrames.push(String(d)));
  const stdout = new PassThrough();
  const exit = new EventEmitter();
  const host = runSide({ input: stdin, output: stdout, accept: side.accept, onEnd: () => exit.emit("exit", 0) });
  sidePush = host.push;
  return { stdin, stdout, stderr: new PassThrough(), kill: () => stdin.end(), on: (e, l) => exit.on(e, l) };
}
let sidePush: (p: PushPayload) => void = () => {};
/** What the hub wrote to the side's stdin. */
const sideFrames: string[] = [];

/** A side whose start script stops at a missing prerequisite. */
function failingSide(code: string): SideProcess {
  const stdout = new PassThrough();
  const exit = new EventEmitter();
  setTimeout(() => (stdout.write(`Welcome to Ubuntu\nCLAUDE_UI_SETUP ${code} v20.1.0\n`), setTimeout(() => exit.emit("exit", 3), 10)), 10);
  return { stdin: new PassThrough(), stdout, stderr: new PassThrough(), kill: () => {}, on: (e, l) => exit.on(e, l) };
}

const hasSh = spawnSync("sh", ["-c", "true"]).status === 0;

const pushes: PushPayload[] = [];
let saved: string[] = [];
const sides = createSides({
  targets: [wslSide("Ubuntu"), wslSide("Old")],
  spawn: (id) => (id === "wsl:Ubuntu" ? inProcessSide() : failingSide("node_old")),
  onPush: (p) => pushes.push(p),
  save: (ids) => (saved = ids),
  posixLocal: true,
});
const hub = createDaemon({ webRoot, token, roots: [winRoot], query: fakeQuery as never, projects: createProjects(), history: { listSessions: (async () => []) as never, getSessionInfo: (async () => undefined) as never, getSessionMessages: (async () => []) as never }, sides });
await new Promise<void>((r) => hub.listen(0, "127.0.0.1", r));
const { port } = hub.address() as AddressInfo;
afterAll(() => void (hub.close(), sides.close()));

async function client(p = port) {
  const ws = new WebSocket(`ws://127.0.0.1:${p}/ws`, [WS_PROTOCOL, TOKEN_PROTOCOL_PREFIX + token], { origin: `http://127.0.0.1:${p}` });
  const inbox: ServerMessage[] = [];
  ws.on("message", (d) => inbox.push(JSON.parse(String(d))));
  await new Promise((r) => ws.once("open", r));
  const waitFor = (pred: (m: ServerMessage) => boolean) =>
    new Promise<ServerMessage>((resolve) => {
      const t = setInterval(() => {
        const m = inbox.find(pred);
        if (m) clearInterval(t), resolve(m);
      }, 5);
    });
  const request = async (msg: object): Promise<any> => {
    const reqId = Math.random().toString(36);
    ws.send(JSON.stringify({ ...msg, reqId }));
    return waitFor((m) => (m.type === "reply" || m.type === "error") && m.reqId === reqId);
  };
  return { ws, inbox, waitFor, request };
}

describe("sides", () => {
  it("parses wsl.exe -l -q (UTF-16LE) without Docker Desktop's distros", () => {
    expect(parseDistros(Buffer.from("Ubuntu\r\ndocker-desktop\r\nrancher-desktop-data\r\nDebian\r\n\r\n", "utf16le"))).toEqual(["Ubuntu", "Debian"]);
    expect(parseDistros(Buffer.from("Ubuntu\n"))).toEqual(["Ubuntu"]);
  });

  it("passes the setup script to wsl.exe without quotes or newlines on the command line", () => {
    const args = wslArgs("Ubuntu", setupScript("C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\claude-code-ui", "1.2.3-1700000000000"));
    expect(args.slice(0, 5)).toEqual(["-d", "Ubuntu", "--exec", "bash", "-lic"]);
    expect(args[5]).not.toMatch(/["\n]/);
    const script = Buffer.from(/echo (\S+) \|/.exec(args[5]!)![1]!, "base64").toString();
    expect(script).toContain("wslpath -u 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\claude-code-ui'");
    expect(script).toContain('dir="$root/1.2.3-1700000000000"');
    expect(script).toContain('exec node "$cli" --side');
  });

  it("the setup script installs into a temp folder, checks it, and only then moves it over the old install", () => {
    for (const kind of ["wsl", "docker"] as const) {
      const s = setupScript(kind === "docker" ? "/tmp/a.tgz" : "C:\\p", "1.2.3-1", kind);
      const at = (part: string) => { const i = s.indexOf(part); expect(i, part).toBeGreaterThan(-1); return i; };
      const order = [at('npm install --prefix "$new"'), at('[ -f "$new/node_modules/claude-code-ui/dist/cli.js" ]'), at('sdk "$new"'), at('node "$new/node_modules/claude-code-ui/dist/cli.js" --version'), at('mv "$dir" "$old"'), at('mv "$new" "$dir"')];
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(s).not.toContain('npm install --prefix "$dir"');
      expect(s).not.toMatch(/rm -rf "\$dir"; mkdir/);
      expect(s).toContain("install_failed");
      expect(s.split("\n").some((l) => /^ *\[ -e "\$dir" \]|if \[ -e "\$dir" \]/.test(l))).toBe(true);
    }
  });

  it("the docker setup script runs in plain sh: the tarball, no wslpath, roots from the working dir", () => {
    const s = setupScript("/tmp/claude-ui-side-0.2.0-1.tgz", "0.2.0-1", "docker");
    for (const part of ["src='/tmp/claude-ui-side-0.2.0-1.tgz'", 'CLAUDE_UI_ROOTS="$HOME:$PWD"', "say build_tools_missing", "CLAUDE_CODE_OAUTH_TOKEN", 'exec node "$cli" --side', 'rm -f "$src"']) expect(s).toContain(part);
    for (const part of ["wslpath", "<(", "[[", "--install-links", "-exec"]) expect(s).not.toContain(part);
    expect(dockerExecArgs("dev", s)).toEqual(["exec", "-i", "dev", "sh", "-c", s]);
    if (hasSh) expect(spawnSync("sh", ["-n", "-c", s]).status).toBe(0);
  });

  // npm skips an optional dependency it could not fetch: a side without the SDK's Linux binary lists no models (no auto mode) and runs no prompt.
  describe.skipIf(!hasSh || process.platform === "win32")("the setup script and the SDK's Linux binary", () => {
    const key = "0.4.1-1";
    /** Runs the docker setup script with a fake npm (writes the package; the SDK binary only when `native`); the npm calls and the output. */
    function setup({ installed, native, fail, seed, broken }: { installed?: "complete" | "no-binary"; native: boolean; fail?: boolean; broken?: boolean; seed?: string[] }) {
      const home = dir("side-home-");
      const bin = dir("side-bin-");
      const log = join(home, "npm.log");
      const pkg = (prefix: string, withBinary: boolean) => {
        mkdirSync(join(prefix, "node_modules/claude-code-ui/dist"), { recursive: true });
        writeFileSync(join(prefix, "node_modules/claude-code-ui/dist/cli.js"), 'console.log("side started")');
        if (withBinary) mkdirSync(join(prefix, "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64"), { recursive: true });
      };
      const sideDir = join(home, ".local/share/claude-ui/side", key);
      if (installed) pkg(sideDir, installed === "complete");
      const root = join(home, ".local/share/claude-ui/side");
      for (const s of seed ?? []) pkg(join(root, s), true);
      for (const tool of ["make", "python3", "g++"]) writeFileSync(join(bin, tool), "#!/bin/sh\n", { mode: 0o755 });
      // Like npm: an existing node_modules without the optional dependency does not get it.
      const writeBinary = native ? '[ "$fresh" = 1 ] && mkdir -p "$p/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64"' : "";
      const failNow = fail ? '\necho "npm ERR! network request failed" >&2\nexit 1' : "";
      const cliSource = broken ? "process.exit(1)" : 'console.log("side started")';
      const npm = `#!/bin/sh\nwhile [ "$1" != --prefix ]; do shift; done; p=$2\necho "$p" >> '${log}'\nfresh=1; [ -d "$p/node_modules" ] && fresh=0\nmkdir -p "$p/node_modules/claude-code-ui/dist"\n${fail ? 'echo partial > "$p/node_modules/partial"' : `echo '${cliSource}' > "$p/node_modules/claude-code-ui/dist/cli.js"`}${failNow}\n${writeBinary}\n`;
      writeFileSync(join(bin, "npm"), npm, { mode: 0o755 });
      const tgz = join(home, "side.tgz");
      writeFileSync(tgz, "");
      const r = spawnSync("sh", ["-c", setupScript(tgz, key, "docker")], { cwd: home, encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, ANTHROPIC_API_KEY: "test" } });
      const prefixes = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
      const entries = existsSync(root) ? readdirSync(root).sort() : [];
      return { status: r.status, out: r.stdout, npmCalls: prefixes.length, prefixes, entries, root, sideDir };
    }
    const cliOf = (d: string) => join(d, "node_modules/claude-code-ui/dist/cli.js");
    const binOf = (d: string) => join(d, "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64");

    it("installs into a temp folder, then swaps it in over an install without the binary, then starts", () => {
      const r = setup({ installed: "no-binary", native: true });
      expect(r.npmCalls).toBe(1);
      expect(r.prefixes[0]).not.toBe(r.sideDir);
      expect(r.prefixes[0]).toMatch(/\.new-\d+$/);
      expect(r.out).toContain("side started");
      expect(existsSync(binOf(r.sideDir))).toBe(true);
      expect(r.entries).toEqual([key]);
    });

    it("fails the setup with install_failed when npm leaves the binary out", () => {
      const r = setup({ native: false });
      expect(r.status).toBe(3);
      expect(r.out).toMatch(/^CLAUDE_UI_SETUP install_failed .*Claude Agent SDK/m);
      expect(r.out).not.toContain("side started");
      expect(existsSync(r.sideDir)).toBe(false);
      expect(r.entries).toEqual([]);
    });

    it("keeps the old install when npm fails", () => {
      const r = setup({ installed: "no-binary", native: true, fail: true });
      expect(r.status).toBe(3);
      expect(r.out).toMatch(/^CLAUDE_UI_SETUP install_failed .*npm ERR! network/m);
      expect(existsSync(cliOf(r.sideDir))).toBe(true);
      expect(r.entries).toEqual([key]);
    });

    it("keeps the old install when npm leaves the binary out again", () => {
      const r = setup({ installed: "no-binary", native: false });
      expect(r.status).toBe(3);
      expect(r.out).toMatch(/^CLAUDE_UI_SETUP install_failed .*Claude Agent SDK/m);
      expect(existsSync(cliOf(r.sideDir))).toBe(true);
      expect(r.entries).toEqual([key]);
    });

    it("a failed install leaves earlier versions alone; a successful one removes them", () => {
      const failed = setup({ installed: "no-binary", native: true, fail: true, seed: ["0.4.0-1"] });
      expect(failed.entries).toEqual(["0.4.0-1", key]);
      expect(existsSync(cliOf(join(failed.root, "0.4.0-1")))).toBe(true);
      const ok = setup({ installed: "no-binary", native: true, seed: ["0.4.0-1"] });
      expect(ok.entries).toEqual([key]);
    });

    it("sweeps the leftovers of a killed run after a successful install", () => {
      const r = setup({ installed: "no-binary", native: true, seed: [".new-123", ".old-456"] });
      expect(r.out).toContain("side started");
      expect(r.entries).toEqual([key]);
    });

    it("keeps the old install when the new one does not run", () => {
      const r = setup({ installed: "no-binary", native: true, broken: true });
      expect(r.status).toBe(3);
      expect(r.out).toMatch(/^CLAUDE_UI_SETUP install_failed .*does not start/m);
      expect(r.out).not.toContain("side started");
      expect(existsSync(cliOf(r.sideDir))).toBe(true);
      expect(existsSync(binOf(r.sideDir))).toBe(false);
      expect(r.entries).toEqual([key]);
    });

    it("starts a complete install without npm", () => {
      const r = setup({ installed: "complete", native: true });
      expect(r.npmCalls).toBe(0);
      expect(r.out).toContain("side started");
    });
  });

  it("setup errors in a container name the container's next step", () => {
    expect(setupMessage("not_logged_in", "", "Docker: dev", true)).toBe("Claude is not logged in to Docker: dev. Run claude login in the container or copy your ~/.claude/.credentials.json into it (or start it with ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN set), then retry.");
    expect(setupMessage("node_missing", "", "Docker: dev", true)).toBe("Node.js 22 or newer is not installed in Docker: dev. Use an image with Node.js 22+ (e.g. node:22) or install it in the container, then retry.");
    expect(setupMessage("build_tools_missing", "", "WSL: Ubuntu")).toBe("WSL: Ubuntu needs make, python3 and g++ to build the terminal support (node-pty). Install them there (Debian/Ubuntu: apt-get install -y make python3 g++; Alpine: apk add make python3 g++), then retry.");
  });

  it("lists every side; a side's projects and sessions join the list once it is started", async () => {
    const c = await client();
    const before = await c.request({ type: "session.list" });
    expect(before.result.sides).toEqual([
      { id: "local", label: "Windows", state: "ready" },
      { id: "wsl:Ubuntu", label: "WSL: Ubuntu", state: "off" },
      { id: "wsl:Old", label: "WSL: Old", state: "off" },
    ]);
    expect(before.result.sessions).toEqual([]);

    expect(await c.request({ type: "side.start", side: "wsl:Ubuntu" })).toMatchObject({ type: "reply" });
    expect(saved).toEqual(["wsl:Ubuntu"]);
    // The side's folders, from the picker's side chooser.
    expect((await c.request({ type: "fs.list", side: "wsl:Ubuntu" })).result.entries).toEqual([{ name: wslRoot, path: wslRoot, isDir: true }]);
    expect((await c.request({ type: "fs.list" })).result.entries).toEqual([{ name: winRoot, path: winRoot, isDir: true }]);
    expect(await c.request({ type: "project.open", cwd: wslRoot, side: "wsl:Ubuntu" })).toMatchObject({ result: { cwd: wslRoot } });

    const after = await c.request({ type: "session.list" });
    expect(after.result.projects).toEqual([wslRoot]);
    expect(after.result.sessions).toMatchObject([{ id: sideSession, cwd: wslRoot, title: "side work" }]);
    expect(after.result.cwdSides).toEqual({ [wslRoot]: "wsl:Ubuntu" });
    expect(after.result.sides[1]).toEqual({ id: "wsl:Ubuntu", label: "WSL: Ubuntu", state: "ready" });
    c.ws.close();
  });

  // Routes by the path's form: a real WSL path is POSIX, while this test stands in for it with a native temp dir, which on a Windows host is a Windows path and so (correctly) local.
  // The in-process side needs that same path on the real filesystem, so these cannot run on Windows; they run on Linux and macOS.
  it.skipIf(process.platform === "win32")("routes a side project's sessions to the side: create, subscribe, prompt, events", async () => {
    const c = await client();
    await c.request({ type: "side.start", side: "wsl:Ubuntu" });
    await c.request({ type: "session.list" });
    const created = await c.request({ type: "session.create", cwd: wslRoot });
    const id = created.result.session.id;
    expect(created.result.session.cwd).toBe(wslRoot);
    await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
    expect(await c.request({ type: "session.prompt", sessionId: id, text: "hi" })).toMatchObject({ type: "reply" });
    await c.waitFor((m) => m.type === "event" && m.sessionId === id && m.part.type === "turn_result");
    // A local project stays local.
    const local = await c.request({ type: "session.create", cwd: winRoot });
    expect(local.result.session.cwd).toBe(winRoot);
    // The side's own sessions are listed; the local one is not a side session.
    const list = await c.request({ type: "session.list" });
    expect(list.result.cwdSides[winRoot]).toBeUndefined();
    c.ws.close();
  });

  it("finds a side session by ID on a link before the list, and forwards the side's pushes", async () => {
    const c = await client();
    await c.request({ type: "side.start", side: "wsl:Ubuntu" });
    sides.sessionSide.delete(sideSession);
    expect(await c.request({ type: "session.subscribe", sessionId: sideSession, sinceSeq: 0 })).toMatchObject({ result: { session: { id: sideSession, cwd: wslRoot } } });
    // The router's probe of the sides is a background subscription: it must not hold the side session's CLI forever.
    expect(sideFrames.join("")).toMatch(/"sinceSeq":9007199254740991,"background":true/);
    sidePush({ sessionId: sideSession, title: "side work", body: "Finished" });
    await expect.poll(() => pushes).toEqual([{ sessionId: sideSession, title: "side work", body: "Finished" }]);
    c.ws.close();
  });

  it("a side that cannot start says what to do; the error shows in the side list", async () => {
    const c = await client();
    const r = await c.request({ type: "side.start", side: "wsl:Old" });
    expect(r).toMatchObject({ type: "error", code: "side_failed" });
    expect(r.message).toBe("Node.js v20.1.0 in WSL: Old is too old: 22 or newer is needed. Update it there (e.g. nvm install 22), then retry.");
    const list = await c.request({ type: "session.list" });
    expect(list.result.sides[2]).toMatchObject({ id: "wsl:Old", state: "error", message: r.message });
    expect(await c.request({ type: "fs.list", side: "wsl:Old" })).toMatchObject({ type: "error", code: "side_not_ready" });
    c.ws.close();
  });

  it("merges a side project's worktrees into the list and routes their paths to the side", async () => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: wslRoot, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
    git("worktree", "add", "-q", "-b", "feat", join(wslRoot, "wt"));
    const c = await client();
    await c.request({ type: "side.start", side: "wsl:Ubuntu" });
    const list = await c.request({ type: "session.list" });
    expect(list.result.worktrees).toEqual({
      [wslRoot]: [
        { path: wslRoot, branch: "main", main: true },
        { path: join(wslRoot, "wt"), branch: "feat", main: false },
      ],
    });
    expect(list.result.cwdSides[join(wslRoot, "wt")]).toBe("wsl:Ubuntu");
    c.ws.close();
  });

  // Routes by the path's form: a real WSL path is POSIX, while this test stands in for it with a native temp dir, which on a Windows host is a Windows path and so (correctly) local.
  // The in-process side needs that same path on the real filesystem, so these cannot run on Windows; they run on Linux and macOS.
  it.skipIf(process.platform === "win32")("fs.media of a side path fails side_unsupported; a local path is served", async () => {
    writeFileSync(join(wslRoot, "s.png"), "png");
    writeFileSync(join(winRoot, "l.png"), "png");
    const c = await client();
    await c.request({ type: "side.start", side: "wsl:Ubuntu" });
    await c.request({ type: "session.list" });
    expect(await c.request({ type: "fs.media", path: join(wslRoot, "s.png") })).toMatchObject({ type: "error", code: "side_unsupported", message: "Preview is not available for files in WSL" });
    const ok = await c.request({ type: "fs.media", path: join(winRoot, "l.png") });
    expect(ok).toMatchObject({ type: "reply", result: { mime: "image/png", size: 3 } });
    c.ws.close();
  });
});

describe("docker state freshness", () => {
  it("a change of the Docker state alone (down, empty, ok) sends a change, so an open dialog updates its hint", async () => {
    let engine: "ok" | "down" | "empty" | undefined;
    let known: typeof engine;
    // main.ts keeps the state it found inside discover.
    const hub = createSides({ targets: [], discoverMs: 0, spawn: () => Promise.reject(new Error("unused")), dockerState: () => known, discover: async () => ((known = engine), []) });
    let changes = 0;
    hub.onChange(() => changes++);
    for (const s of ["down", "empty", "ok", "down"] as const) {
      engine = s;
      const before = changes;
      await hub.refresh();
      expect(changes, s).toBe(before + 1);
      expect(hub.docker()).toBe(s);
    }
    // The same state again: nothing to announce.
    const same = changes;
    await hub.refresh();
    expect(changes).toBe(same);
  });
});

const dockRoot = dir("dock-");
const dockSession = "6e2f3a4b-5c6d-4e7f-8091-92b3c4d5e6f7";

// These route by POSIX paths (the side's roots are POSIX): they run where the daemon runs, on Linux and macOS.
describe.skipIf(process.platform === "win32")("docker sides", () => {
  const localRoot = join(dockRoot, "host");
  mkdirSync(localRoot);
  let dockSaved: string[] = [];
  let containers = ["dev", "stopped"];
  let dockerState: "ok" | "down" | "empty" | undefined = "ok";
  let devProc: SideProcess;
  let sideDaemon: ReturnType<typeof createDaemon>;
  const dsides = createSides({
    targets: [],
    localLabel: "Linux",
    posixLocal: true,
    discoverMs: 0,
    discover: async () => containers.map(dockerSide),
    dockerState: () => dockerState,
    spawn: async (id) => (id === "docker:dev" ? (devProc = inProcessSide(dockRoot, dockSession, (d) => (sideDaemon = d))) : Promise.reject(new Error("Docker: stopped is not running. Start it (docker start stopped), then retry."))),
    save: (ids) => (dockSaved = ids),
  });
  const dhub = createDaemon({ webRoot, token, roots: [localRoot], query: fakeQuery as never, projects: createProjects(), appSettings: createSettings(), history: { listSessions: (async () => []) as never, getSessionInfo: (async () => undefined) as never, getSessionMessages: (async () => []) as never }, sides: dsides });
  const ready = new Promise<void>((r) => dhub.listen(0, "127.0.0.1", r));
  const dport = async () => (await ready, (dhub.address() as AddressInfo).port);
  afterAll(() => void (dhub.close(), dsides.close()));

  it("lists running containers as sides after discovery; local is Linux", async () => {
    const c = await client(await dport());
    await dsides.refresh();
    const list = await c.request({ type: "session.list" });
    expect(list.result.sides).toEqual([
      { id: "local", label: "Linux", state: "ready" },
      { id: "docker:dev", label: "Docker: dev", state: "off" },
      { id: "docker:stopped", label: "Docker: stopped", state: "off" },
    ]);
    c.ws.close();
  });

  it("session.list carries the Docker state next to the sides, and leaves the field out when unknown", async () => {
    const c = await client(await dport());
    expect((await c.request({ type: "session.list" })).result.docker).toBe("ok");
    for (const s of ["down", "empty"] as const) {
      dockerState = s;
      expect((await c.request({ type: "session.list" })).result.docker).toBe(s);
    }
    dockerState = undefined;
    expect("docker" in (await c.request({ type: "session.list" })).result).toBe(false);
    dockerState = "ok";
    c.ws.close();
  });

  it("a container that cannot start shows its next step", async () => {
    const c = await client(await dport());
    const r = await c.request({ type: "side.start", side: "docker:stopped" });
    expect(r).toMatchObject({ type: "error", code: "side_failed", message: "Docker: stopped is not running. Start it (docker start stopped), then retry." });
    const list = await c.request({ type: "session.list" });
    expect(list.result.sides[2]).toEqual({ id: "docker:stopped", label: "Docker: stopped", state: "error", message: r.message });
    c.ws.close();
  });

  it("starts a container side from the chooser; its projects and sessions route to it", async () => {
    const c = await client(await dport());
    expect(await c.request({ type: "side.start", side: "docker:dev" })).toMatchObject({ type: "reply" });
    expect(dockSaved).toEqual(["docker:dev"]);
    expect((await c.request({ type: "fs.list", side: "docker:dev" })).result.entries).toEqual([{ name: dockRoot, path: dockRoot, isDir: true }]);
    expect(await c.request({ type: "project.open", cwd: dockRoot, side: "docker:dev" })).toMatchObject({ result: { cwd: dockRoot } });
    await c.request({ type: "session.list" });
    const created = await c.request({ type: "session.create", cwd: dockRoot });
    const id = created.result.session.id;
    expect(created.result.session.cwd).toBe(dockRoot);
    await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
    expect(await c.request({ type: "session.prompt", sessionId: id, text: "hi" })).toMatchObject({ type: "reply" });
    await c.waitFor((m) => m.type === "event" && m.sessionId === id && m.part.type === "turn_result");
    const list = await c.request({ type: "session.list" });
    expect(list.result.cwdSides[dockRoot]).toBe("docker:dev");
    c.ws.close();
  });

  it("a host project under a container's cwd stays local on a POSIX hub", async () => {
    const c = await client(await dport());
    await c.request({ type: "project.open", cwd: localRoot, side: "local" });
    await c.request({ type: "session.list" });
    expect(dsides.pathSide(localRoot)).toBe("local");
    expect(dsides.pathSide(join(dockRoot, "x"))).toBe("docker:dev");
    c.ws.close();
  });

  it("a gone container leaves the list unless it failed; a new one joins", async () => {
    const c = await client(await dport());
    containers = ["dev", "new"];
    await dsides.refresh();
    const ids = (r: any) => r.result.sides.map((s: { id: string; state: string }) => `${s.id}:${s.state}`);
    expect(ids(await c.request({ type: "session.list" }))).toEqual(["local:ready", "docker:dev:ready", "docker:stopped:error", "docker:new:off"]);
    containers = ["dev"];
    await dsides.refresh();
    expect(ids(await c.request({ type: "session.list" }))).toEqual(["local:ready", "docker:dev:ready", "docker:stopped:error"]);
    c.ws.close();
  });

  it("the hub's settings reach a side, so a coordinator there starts workers in the container", async () => {
    const c = await client(await dport());
    await c.request({ type: "side.start", side: "docker:dev" });
    expect(await c.request({ type: "settings.set", patch: { orchestration: { enabled: true } } })).toMatchObject({ type: "reply" });
    await expect.poll(async () => (await c.request({ type: "settings.get", side: "docker:dev" })).result?.settings.orchestration.enabled).toBe(true);
    const coord = await c.request({ type: "session.create", cwd: dockRoot });
    expect(coord).toMatchObject({ type: "reply" });
    const tools = sideDaemon.orchestration.tools(coord.result.session.id);
    const r = (await tools.find((t) => t.name === "worker_start")!.handler({ name: "w1", cwd: dockRoot, prompt: "p" } as never, {})) as { content: { text: string }[]; isError?: boolean };
    expect(r.isError).toBeFalsy();
    const worker = JSON.parse(r.content[0]!.text);
    expect(worker.cwd).toBe(dockRoot);
    const list = await c.request({ type: "session.list" });
    expect(list.result.sessions.some((s: { id: string }) => s.id === worker.sessionId)).toBe(true);
    expect(list.result.cwdSides[dockRoot]).toBe("docker:dev");
    c.ws.close();
  });

  it("a coordinator on the host cannot start a worker in a container", async () => {
    const c = await client(await dport());
    const coord = await c.request({ type: "session.create", cwd: localRoot, side: "local" });
    expect(coord).toMatchObject({ type: "reply" });
    const tools = dhub.orchestration.tools(coord.result.session.id);
    const r = (await tools.find((t) => t.name === "worker_start")!.handler({ name: "w2", cwd: dockRoot, prompt: "p" } as never, {})) as { content: { text: string }[]; isError?: boolean };
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/is on Docker: dev: a coordinator starts workers on its own side only/);
    c.ws.close();
  });

  it("a stopped container puts its side in error", async () => {
    const c = await client(await dport());
    devProc.kill();
    await expect
      .poll(async () => (await c.request({ type: "session.list" })).result.sides.find((s: { id: string }) => s.id === "docker:dev"))
      .toEqual({ id: "docker:dev", label: "Docker: dev", state: "error", message: "Docker: dev stopped (exit code 0). Retry to start it again." });
    c.ws.close();
  });
});

describe("docker side discovery", () => {
  it("a saved container side starts when discovery lists it", async () => {
    let s2: string[] = [];
    const spawn = vi.fn(async () => inProcessSide(dockRoot, dockSession));
    const s = createSides({ targets: [], saved: ["docker:dev", "wsl:Gone"], discoverMs: 0, discover: async () => [dockerSide("dev")], spawn, save: (ids) => (s2 = ids) });
    expect(s.list().some((x) => x.id.startsWith("docker:"))).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
    await s.refresh();
    await expect.poll(() => s.list().find((x) => x.id === "docker:dev")?.state).toBe("ready");
    expect(s2).toEqual(expect.arrayContaining(["docker:dev", "wsl:Gone"]));
    await s.refresh();
    expect(spawn).toHaveBeenCalledTimes(1);
    s.close();
  });

  it("discovery is throttled", async () => {
    const discover = vi.fn(async () => []);
    const s = createSides({ targets: [], spawn: () => failingSide("x"), discover, discoverMs: 60_000 });
    await s.refresh();
    await s.refresh();
    expect(discover).toHaveBeenCalledTimes(1);
  });
});

/** A side that speaks the frame protocol by hand: `answer` returns the result of each request. */
function scriptedSide(answer: (m: { type: string }) => unknown): SideProcess {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const exit = new EventEmitter();
  let buf = "";
  stdin.on("data", (d) => {
    buf += d;
    const parts = buf.split("\n");
    buf = parts.pop()!;
    for (const line of parts) {
      const f = JSON.parse(line) as { c: number; m?: { type: string; reqId: string } };
      if (f.m) stdout.write(JSON.stringify({ c: f.c, m: { type: "reply", reqId: f.m.reqId, result: answer(f.m) } }) + "\n");
    }
  });
  stdout.write(JSON.stringify({ ready: true }) + "\n");
  return { stdin, stdout, stderr: new PassThrough(), kill: () => {}, on: (e, l) => exit.on(e, l) };
}

describe("local cwds on a POSIX hub", () => {
  const hostCwd = "/work/host";
  const list = (cwd: string) => ({ sessions: [{ id: "s1", cwd, lastActivity: 1 }], projects: [cwd], recentProjects: [] });
  async function setup(answer: (m: { type: string }) => unknown) {
    const s = createSides({ targets: [], localLabel: "Linux", posixLocal: true, discoverMs: 0, discover: async () => [dockerSide("dev")], spawn: () => scriptedSide(answer) });
    await s.refresh();
    await s.start("docker:dev");
    const sent: ServerMessage[] = [];
    const router = createRouter({
      sides: s,
      send: (m) => sent.push(m),
      local: async () => {},
      localCall: async (msg) => ({ type: "reply", reqId: msg.reqId, result: msg.type === "session.list" ? list(hostCwd) : {} }),
      isLocalSession: async () => false,
    });
    const request = async (msg: object) => {
      const before = sent.length;
      await router.handle({ ...msg, reqId: "r" + before } as never);
      return sent.slice(before).find((m) => m.type === "reply" || m.type === "error") as any;
    };
    return { s, router, request };
  }

  it("a side whose session.list claims a local cwd does not take its routing", async () => {
    const { s, router, request } = await setup((m) => (m.type === "session.list" ? list(hostCwd) : {}));
    const r = await request({ type: "session.list" });
    expect(r.result.cwdSides[hostCwd]).toBeUndefined();
    expect(s.pathSide(hostCwd)).toBe("local");
    expect(s.pathSide(hostCwd + "/sub")).toBe("local");
    router.close();
    s.close();
  });

  it("a side reply carrying a local cwd does not remap it", async () => {
    const { s, router, request } = await setup((m) => (m.type === "session.list" ? list("/ct/other") : m.type === "project.open" ? { cwd: hostCwd } : m.type === "session.create" ? { session: { id: "s2", cwd: hostCwd } } : {}));
    await request({ type: "session.list" });
    await request({ type: "project.open", cwd: hostCwd, side: "docker:dev" });
    await request({ type: "session.create", cwd: "/ct/other", side: "docker:dev" });
    expect(s.pathSide(hostCwd)).toBe("local");
    expect(s.pathSide("/ct/other")).toBe("docker:dev");
    router.close();
    s.close();
  });

  it("a spawn failure names the side", async () => {
    const s = createSides({ targets: [dockerSide("gone")], localLabel: "Linux", posixLocal: true, spawn: () => Promise.reject(new Error("docker exited")) });
    await expect(s.start("docker:gone")).rejects.toThrow("Docker: gone: docker exited");
    expect(s.list().find((x) => x.id === "docker:gone")?.message).toBe("Docker: gone: docker exited");
    const named = createSides({ targets: [dockerSide("gone")], spawn: () => Promise.reject(new Error("Docker: gone is not running.")) });
    await expect(named.start("docker:gone")).rejects.toThrow(/^Docker: gone is not running\.$/);
    s.close();
    named.close();
  });
});
