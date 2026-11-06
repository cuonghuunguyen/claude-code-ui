import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect as netConnect, createServer as netServer, type AddressInfo } from "node:net";
import { homedir, networkInterfaces, release, userInfo } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { HELP, PHONE_HINT, USAGE_HINT, autoOpen, isDaemonRun, parseCli } from "./cli.ts";
import { createSettings } from "./settings.ts";
import { createShortcut } from "./shortcut.ts";
import { createSecrets } from "./secrets.ts";
import { createProjects } from "./projects.ts";
import { createPush, type Push } from "./push.ts";
import { createDaemon } from "./server.ts";
import { createAttachServer } from "./side-daemon.ts";
import { attachSocketPath, claimSocket, findHub, hubBridgeScript, hubExec, liveInstall, prepareSockDir, runAttach } from "./side-attach.ts";
import { HUB_PROBE } from "./hub-probe.ts";
import { SIDE_SCHEMA } from "./side-frame.ts";
import { createKeepAwake, inhibitorFor } from "./keep-awake.ts";
import { markUsed, safeKey, sideCacheDir } from "./side-bundle.ts";
import { checkDockerSide, dockerStatus, execRun, folderPath, prepareDockerSide } from "./docker-side.ts";
import { runGit, setGitRunner, threadRunner } from "./git-runner.ts";
import { wslGitRunner } from "./wsl-git.ts";
import { prepareWslSide } from "./wsl-side.ts";
import { addSshHost, checkSshSide, listSshHosts, prepareSshSide, sshArgs, sshConfigPath, sshError } from "./ssh-side.ts";
import { kindOf, nameOf, sideTarget, type SideKindImpl } from "./side-kinds.ts";
import { attachArgs, checkWslSide, createSides, effectiveSetup, parseSaved, type SavedSide, dockerExecArgs, forwardSidePush, dockerSide, parseDistros, setupScript, wslArgs, wslSide, type SideProcess } from "./sides.ts";
import type { DockerState, SidePhase, SideSetup } from "@claude-ui/protocol";
import { exitOnSignal, logExit } from "./exit-log.ts";
import { readProcessTable, watchChain, wrapperChain } from "./ancestors.ts";
import { startServe, tailscalePreflight } from "./tailscale.ts";
import { askUpdate, openInBrowser, runClient, updateLiveHub } from "./ctl/commands.ts";
import { pidAlive, readToken, tokenPath } from "./ctl/connect.ts";
import { retireAttachHub } from "./ctl/retire.ts";
import { claimDaemonFile, readDaemonFile } from "./ctl/daemon-file.ts";
import { configDir, loadToken, pairingUrl } from "./token.ts";
import { defaultUploadsDir } from "./uploads.ts";
import { installVersion, latestNewer, parseRegistry, pruneVersions, versionsDir } from "./update.ts";
import { createBuildInfo } from "./build-info.ts";

// Set by the bridge of another Hub's attach (ADR 0009); not inherited by the children of this Hub.
const startedBy = process.env.CLAUDE_UI_STARTED_BY === "attach" ? ("attach" as const) : undefined;
delete process.env.CLAUDE_UI_STARTED_BY;
const appSettings = createSettings({ file: join(configDir(), "settings.json") });
const argv = process.argv.slice(2);
// Saved Settings › Launcher options: a daemon start of the user only (not a client command, not a Hub another computer's attach started).
const cli = parseCli(argv, process.env, homedir(), isDaemonRun(argv) && !startedBy ? appSettings.get().launcher : undefined);
// The exit line is for a daemon's log; a client command, update, help or a usage error prints only its own output.
logExit(process, (line) => cli.kind === "run" && console.error(line));
let cleanup = () => {};
exitOnSignal(process, () => cleanup());

const realOr = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
if (cli.kind === "help") (console.log(HELP), process.exit(0));
// The package.json next to dist/ (installed) or src/ (source checkout, no version: "dev").
const version: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "dev";
if (cli.kind === "version") (console.log(version), process.exit(0));
if (cli.kind === "error") (console.error(`claude-ui: ${cli.message}\n${USAGE_HINT}`), process.exit(2));
if (cli.kind === "client") {
  // A client command only talks to a running daemon: no token creation, sides or update check. Never exits 75.
  process.exit(await runClient(cli, { env: process.env, dir: configDir(), stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s), openUrl: openInBrowser }));
}
if (cli.kind === "attach") {
  // The bridge to the Hub of this machine (side-attach.ts); `--start` first starts a detached Hub (this same build) when none runs.
  const dir = configDir();
  const start = () => {
    // A fresh container has no config folder yet.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const log = openSync(join(dir, "attach-hub.log"), "a", 0o600);
    spawn(process.execPath, [process.argv[1]!, "--no-open", "--port", "0"], { detached: true, stdio: ["ignore", log, log], env: { ...process.env, CLAUDE_UI_STARTED_BY: "attach" } }).unref();
  };
  process.exit(await runAttach({ dir, stdin: process.stdin, stdout: process.stdout, ...(cli.start && { start }) }));
}
/** Registry of the update check and install; a mirror, or a fake one in tests. */
let registry: string | undefined;
try {
  registry = parseRegistry(process.env.CLAUDE_UI_UPDATE_REGISTRY);
} catch (e) {
  console.error(`claude-ui: ${(e as Error).message}`);
  process.exit(1);
}
if (cli.kind === "update") {
  if (version === "dev") (console.error("claude-ui: a source checkout does not update; use git pull"), process.exit(1));
  // A Hub runs here: it installs and restarts itself (its versions folder, its idle rule).
  const viaHub = await updateLiveHub({ dir: configDir(), env: process.env, stdout: (t) => process.stdout.write(t), stderr: (t) => process.stderr.write(t) });
  if (viaHub !== undefined) process.exit(viaHub);
  const latest = await latestNewer(version, { registry });
  if (!latest) (console.log(`claude-ui ${version} is the latest version (or the registry is unreachable)`), process.exit(0));
  console.log(`Installing claude-ui ${latest}...`);
  try {
    await installVersion(versionsDir(), latest, { registry });
  } catch (e) {
    console.error(`claude-ui: installing ${latest} failed:\n${(e as Error).message}`);
    process.exit(1);
  }
  console.log(`claude-ui ${latest} installed; it runs from the next start of claude-ui.`);
  process.exit(0);
}
const { port, roots, lan, allowBypass, idleCloseMinutes, updateCheck, osNotify, tailscale, open } = cli;
let hostname = cli.hostname;
// ponytail: LAN addresses are read once at start; an address the network assigns later is refused until a restart.
const lanIps = lan ? Object.values(networkInterfaces()).flat().filter((a) => a && a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")).map((a) => a!.address) : [];
// The installed package ships the web build as dist/web beside this file; a source checkout builds packages/web/dist.
const bundledWeb = new URL("./web", import.meta.url);
const webRoot = fileURLToPath(existsSync(bundledWeb) ? bundledWeb : new URL("../../web/dist", import.meta.url));
const state = { uploadDir: defaultUploadsDir(), historyDir: join(configDir(), "history"), settingsFile: join(configDir(), "sessions.json"), projects: createProjects({ file: join(configDir(), "projects.json") }), appSettings, secrets: createSecrets({ file: join(configDir(), "secrets.json") }) };

// A Hub another computer's attach started here retires first (ADR 0009): a start of the user takes over, attached Hubs follow it. Ctrl-C while waiting
// ends this start only; the retire request stays (that Hub still exits once no turn runs).
const retire = () => retireAttachHub({ dir: configDir(), alive: pidAlive, ask: askUpdate, token: () => readToken(tokenPath({ env: process.env, dir: configDir() }).file), log: console.error });
if (!startedBy && process.platform !== "win32") await retire().catch((e: Error) => (console.error(`claude-ui: an attach-started Claude UI here would not retire: ${e.message}`), process.exit(1)));
const token = loadToken();
const sidesFile = join(configDir(), "sides.json");
const listsFile = join(configDir(), "side-lists.json");
const graceFile = join(configDir(), "side-grace.json");
const attachedFile = join(configDir(), "side-attached.json");
// A Hub started by an attach is headless: it shows no desktop notification; its pushes go to the attached Hubs (and its own subscribers).
const hubPush = createPush({ desktop: () => state.appSettings.get().notifications.desktop, ...((osNotify === false || startedBy) && { notify: false as const }) });
let attachPush: (p: Parameters<Push["send"]>[0]) => void = () => {};
const push: Push = { ...hubPush, send: async (p) => (attachPush(p), hubPush.send(p)) };
const distros = process.platform === "win32" ? wslDistros() : [];
const sidePackage = sidePackageDir();
const sideKey = () => sideKeyOf(sidePackage);
const docker = dockerCli();
const ssh = sshCli();
const sshConfig = sshConfigPath();
// A hub that never starts a side keeps its parts from another hub's prune (7 days unused).
if (existsSync(join(sideCacheDir(), safeKey(version)))) markUsed(sideCacheDir(), safeKey(version));
/** Docker side: the container must run and gets the bundle (or this package for npm), then `docker exec -i <name> sh -c <setup script>`. */
const spawnDocker = async (name: string, setup: SideSetup, onPhase: (p: SidePhase) => void, onInstall?: (i: { bundle: true } | { fallback: string }) => void, pinned?: boolean, bundleOnly?: boolean, runArgs = attachArgs(false)): Promise<SideProcess> => {
  const key = sideKey();
  // A live Hub there with an overlapping schema is bridged through its own cli (GH-619): nothing is installed or sent.
  const hub = await findHub({ runArgs, setup, pinned, run: () => execRun("docker", ["exec", name, "sh", "-c", HUB_PROBE], 15_000) });
  if (hub) return sideChild(spawn("docker", dockerExecArgs(name, hubBridgeScript(hub.exec)), { stdio: "pipe", windowsHide: true }));
  const sent = await prepareDockerSide({ name, pkgDir: sidePackage, key, cacheDir: join(configDir(), "side-pack"), setup, pinned, bundleOnly, onPhase, onInstall, bundle: { cacheRoot: sideCacheDir(), version, registry } });
  return sideChild(spawn("docker", dockerExecArgs(name, setupScript(sent.path, key, "docker", effectiveSetup(setup, bundleOnly, !!sent.bundle), sent.bundle, runArgs)), { stdio: "pipe", windowsHide: true }));
};
/** WSL side: a covered distro installs from the host's verified cached parts read through /mnt (no npm, network or compile in the distro), else from npm. */
const spawnWsl = async (distro: string, setup: SideSetup, onPhase: (p: SidePhase) => void, onInstall?: (i: { bundle: true } | { fallback: string }) => void, pinned?: boolean, bundleOnly?: boolean, runArgs = attachArgs(false)): Promise<SideProcess> => {
  const hub = await findHub({ runArgs, setup, pinned, run: () => execRun("wsl.exe", wslArgs(distro, HUB_PROBE), 30_000) });
  if (hub) return sideChild(spawn("wsl.exe", wslArgs(distro, hubBridgeScript(hub.exec)), { stdio: "pipe", windowsHide: true }));
  const bundle = await prepareWslSide({ distro, pkgDir: sidePackage, setup, pinned, onPhase, onInstall, bundle: { cacheRoot: sideCacheDir(), version, registry } });
  return sideChild(spawn("wsl.exe", wslArgs(distro, setupScript(sidePackage, sideKey(), "wsl", effectiveSetup(setup, bundleOnly, !!bundle), bundle, runArgs)), { stdio: "pipe", windowsHide: true }));
};
/** SSH side: the bundle (a covered Linux host) or the npm tarball (any other POSIX host) goes through ssh stdin, then `ssh <alias>` runs the setup script. */
const spawnSsh = async (alias: string, setup: SideSetup, onPhase: (p: SidePhase) => void, onInstall?: (i: { bundle: true } | { fallback: string }) => void, pinned?: boolean, bundleOnly?: boolean, runArgs = attachArgs(false)): Promise<SideProcess> => {
  const key = sideKey();
  const hub = await findHub({ runArgs, setup, pinned, run: () => execRun("ssh", sshArgs(alias, HUB_PROBE, [], sshConfig), 30_000), fatal: (r) => sshError(alias, r) });
  if (hub) return sideChild(spawn("ssh", sshArgs(alias, hubBridgeScript(hub.exec), [], sshConfig), { stdio: "pipe", windowsHide: true }));
  // A reattach installs and starts nothing: it only bridges to the Hub that runs (setup never: no probe, no bundle).
  const sent = await prepareSshSide({ alias, config: sshConfig, pkgDir: sidePackage, key, cacheDir: join(configDir(), "side-pack"), setup, pinned, bundleOnly, onPhase, onInstall, bundle: { cacheRoot: sideCacheDir(), version, registry } });
  return sideChild(spawn("ssh", sshArgs(alias, setupScript(sent.path, key, "ssh", sent.never ? "never" : effectiveSetup(setup, bundleOnly, !!sent.bundle), sent.bundle, runArgs), [], sshConfig), { stdio: "pipe", windowsHide: true }));
};
const bundle = () => ({ cacheRoot: sideCacheDir(), version, registry });
// One entry per Side kind: start one (probe, install, launch) and check it read-only (side.check).
const runArgsOf = (o: { run?: "update"; attach?: boolean }) => (o.run === "update" ? "update" : attachArgs(!!o.attach));
const kinds: Record<"wsl" | "docker" | "ssh", SideKindImpl> = {
  wsl: { spawn: (n, o) => spawnWsl(n, o.setup, o.phase, o.install, o.pinned, o.bundleOnly, runArgsOf(o)), check: (n) => checkWslSide({ distro: n, pkgDir: sidePackage, key: sideKey(), exec: execRun, bundle: bundle() }) },
  docker: { spawn: (n, o) => spawnDocker(n, o.setup, o.phase, o.install, o.pinned, o.bundleOnly, runArgsOf(o)), check: (n) => checkDockerSide({ name: n, pkgDir: sidePackage, key: sideKey(), bundle: bundle() }) },
  ssh: { spawn: (n, o) => spawnSsh(n, o.setup, o.phase, o.install, o.pinned, o.bundleOnly, runArgsOf(o)), check: (n) => checkSshSide({ alias: n, config: sshConfig, pkgDir: sidePackage, key: sideKey(), bundle: bundle() }) },
};
let dockerState: DockerState | undefined;
const sides =
  distros.length || docker || ssh
    ? createSides({
        targets: distros.map(wslSide),
        localLabel: process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux",
        posixLocal: process.platform !== "win32",
        localDirs: [homedir(), ...roots].flatMap((p) => [p, realOr(p)]),
        // Dynamic kinds list on refresh: Docker containers (and the engine state), ssh config hosts.
        ...((docker || ssh) && { discover: async () => {
            const found: ReturnType<typeof sideTarget>[] = [];
            if (docker) {
              const s = await dockerStatus();
              dockerState = s.state;
              found.push(...s.containers.map(dockerSide));
            }
            if (ssh) found.push(...listSshHosts(sshConfig).map((h) => sideTarget("ssh", h)));
            return found;
          },
          ...(docker && { dockerState: () => dockerState }),
        }),
        // This claude-ui's own package runs in the side: the installed package, or packages/claude-ui of a source checkout (npm start builds it).
        spawn: (id, o) => kinds[kindOf(id)!].spawn(nameOf(id), o),
        grace: { read: () => ((g) => (g && typeof g === "object" && !Array.isArray(g) ? Object.fromEntries(Object.entries(g).filter(([, v]) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 10_080) as [string, number][]) : {}))(readJson(graceFile)), write: (g) => writeFileSync(graceFile, JSON.stringify(g)) },
        attached: { read: () => ((a) => (Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : undefined))(readJson(attachedFile)), write: (ids) => writeFileSync(attachedFile, JSON.stringify(ids)) },
        key: sideKey,
        version,
        ...(ssh && { addSshHost: (command: string, alias?: string) => addSshHost({ command, alias, config: sshConfig }) }),
        check: (id) => kinds[kindOf(id)!].check(nameOf(id)),
        // A start that ssh itself ended (login, host key, network): the message says what to do.
        exitMessage: (id, code, stderr) => (kindOf(id) === "ssh" ? sshError(nameOf(id), { code, stderr }) : undefined),
        onPush: forwardSidePush(push),
        saved: parseSaved(readJson(sidesFile)),
        save: (list: SavedSide[]) => writeFileSync(sidesFile, JSON.stringify({ sides: list })),
        cache: { read: () => ((c) => (c && typeof c === "object" && !Array.isArray(c) ? (c as Record<string, unknown>) : {}))(readJson(listsFile)), write: (c) => (writeFileSync(listsFile, JSON.stringify(c), { mode: 0o600 }), chmodSync(listsFile, 0o600)) },
      })
    : undefined;
void sides?.refresh();
// A project opened by its \\wsl$ path: git runs in the distro (its ready side, else wsl.exe), never Windows git over the UNC path.
if (process.platform === "win32") setGitRunner(wslGitRunner({ local: threadRunner, ...(sides && { side: sides.wslReady, sideRun: sides.git }) }));
const tsEnv = { ...process.env, TAILSCALE_BE_CLI: "1" };
const exec = promisify(execFile);
const ts = tailscale ? await tailscalePreflight({ port, platform: process.platform, env: process.env, exec: (f, a) => exec(f, a, { timeout: 10_000, windowsHide: true, env: tsEnv }) }) : undefined;
// Exit 2 (setup error): the launcher must not read it as a broken release and fall back to an older version.
if (ts && "error" in ts) (console.error(`claude-ui: ${ts.error}`), process.exit(2));
if (ts) hostname = ts.hostname;
cleanup = () => sides?.close();
// Windows does not end children with their parent: a killed npm/tsx/launcher would leave this daemon, its wsl.exe and the WSL side running.
if (process.platform === "win32")
  readProcessTable().then((t) => {
    const stopWatch = watchChain(wrapperChain(t, process.pid), (a) => (console.error(`claude-ui daemon: ${a.name} ${a.pid} that started it ended; stopping`), cleanup(), process.exit(129)), { log: console.error });
    if (stopWatch) process.on("exit", stopWatch);
  }, () => {});
const hostnames = [...(hostname ? [hostname] : []), ...lanIps];
// Only the launcher (dist/launcher.js, the `claude-ui` bin) starts the daemon again after an update restart.
const launched = process.env.CLAUDE_UI_LAUNCHER === "1";
const exitSoon = (code: number) => void setTimeout(() => process.exit(code), 200);
let stopAccepting = () => {};
// A Hub started by an attach has no launcher: its update is a retire (update.ts); the attaching Hub then starts its own build.
const update = startedBy ? { current: version, dir: versionsDir(), registry, exit: exitSoon, retire: { onRetire: () => stopAccepting() } } : updateCheck !== false && version !== "dev" && launched ? { current: version, dir: versionsDir(), registry, exit: exitSoon } : undefined;
// A source checkout compares its files with the start; a release compares its version with the installed ones (build-info.ts).
const buildInfo = createBuildInfo({ version, srcDirs: [fileURLToPath(new URL("../src", import.meta.url)), fileURLToPath(new URL("../../protocol/src", import.meta.url))], versionsDir: versionsDir() });
const keepAwake = createKeepAwake({ inhibitor: inhibitorFor(process.platform, process.pid) });
// Signals end in process.exit; SIGKILL is covered by caffeinate -w / the stdin pipe.
process.on("exit", keepAwake.close);
let attachRunning: (on: boolean) => void = () => {};
const shortcut = startedBy ? undefined : createShortcut({ platform: process.platform, env: process.env, home: homedir(), configDir: configDir(), webRoot, shell: userInfo().shell ?? undefined });
const server = createDaemon({ shortcut, addonsDir: configDir(), webRoot, token, roots, push, keepAwake, onRunning: (on) => attachRunning(on), watchSleep: {}, allowBypass, idleCloseMs: idleCloseMinutes * 60_000, ...state, hostnames, sides, update, buildInfo, desktopForcedOff: osNotify === false, warmUp: true });
// The attach server (ADR 0009): every POSIX Hub accepts attaching Hubs on a Unix socket (mode 0600, same user). A Hub started by an attach also
// records its install folder in `.live` (the install sweep keeps it) and ends after its Grace period.
const attachSock = process.platform === "win32" ? undefined : attachSocketPath(process.env, configDir());
const live = liveInstall(process.argv[1] ?? "");
const attach = attachSock ? createAttachServer({ accept: server.accept, git: runGit, busy: server.busy, browsers: server.browsers, stopIdle: server.stopAll, exit: () => process.exit(0), version, build: live && basename(live.dir), startedBy }) : undefined;
if (attach) ((attachPush = attach.push), (attachRunning = attach.running), (stopAccepting = () => (attach.stopAccepting(), attachNet?.close())));
let attachNet: ReturnType<typeof netServer> | undefined;
/** Whether this process owns the attach socket (resolves once it listens or the claim is given up). */
const attachOwned = new Promise<boolean>((resolve) => {
  if (!attach || !attachSock) return resolve(false);
  const fail = (why: string) => (console.error(`claude-ui: ${why}`), startedBy ? process.exit(1) : resolve(false));
  try {
    prepareSockDir(dirname(attachSock));
  } catch (e) {
    return fail(`no attach socket: ${(e as Error).message}`);
  }
  const claim = (round: number) => {
    const net = (attachNet = netServer((c) => attach.attach(c, c)));
    claimSocket(net, attachSock, {
      // A Hub started by an attach that lost the race leaves: the bridge connects to the winner. A Hub the user started retires an attach-started winner
      // (up to 3 rounds), else runs on without the socket.
      onLive: () => {
        if (startedBy) process.exit(0);
        const d = readDaemonFile(configDir());
        if (d?.startedBy !== "attach" || !pidAlive(d.pid)) return (console.error("claude-ui: another Claude UI here already accepts attaches from other computers; this one does not"), resolve(false));
        if (round >= 3) return fail(`another Claude UI keeps starting here: ${d.pid}`);
        retire().then(() => claim(round + 1), (e: Error) => fail(`would not retire the Claude UI started by an attach: ${e.message}`));
      },
      onError: (e) => fail(`attach socket: ${e.message}`),
    });
    net.once("listening", () => {
      resolve(true);
      // Only once this process owns the socket: a start that loses the race must touch neither the socket nor the running Hub's record.
      if (startedBy && live) writeFileSync(live.file, live.dir);
      process.on("exit", () => (rmSync(attachSock, { force: true }), startedBy && live && rmSync(live.file, { force: true })));
    });
  };
  claim(1);
});
// The Aside leftover probe of other daemons connects to 127.0.0.1: keep binding 127.0.0.1 or 0.0.0.0, never another address.
server.listen(port, lan ? "0.0.0.0" : "127.0.0.1", async () => {
  // Where this daemon listens, for the client commands (no token in it); gone with the process.
  const dir = configDir();
  // `--port 0` (a Hub started by an attach) listens on any free port.
  const actual = (server.address() as AddressInfo).port;
  const owned = await attachOwned;
  // Without the socket, the live Hub that owns it stays the one bridges find (this write must not hide its `attach`).
  const prev = owned ? undefined : readDaemonFile(dir);
  const keptAttach = prev && prev.attach && pidAlive(prev.pid) ? { attach: prev.attach, ...(prev.schema && { schema: prev.schema }), ...(prev.exec && { exec: prev.exec }) } : {};
  try {
    process.on("exit", claimDaemonFile(dir, { port: actual, pid: process.pid, version, startedAt: new Date().toISOString(), ...(owned && attachSock ? { attach: attachSock, schema: [...SIDE_SCHEMA] as [number, number], exec: hubExec() } : keptAttach), ...(startedBy && { startedBy }) }));
  } catch (e) {
    console.error(`claude-ui: cannot write daemon.json: ${(e as Error).message}`);
  }
  if (ts && "cli" in ts) {
    if (ts.serve) {
      const serve = startServe({ cli: ts.cli, port, spawn, log: console.error, platform: process.platform });
      process.on("exit", serve.stop);
    } else console.log(`Tailscale: uses the existing tailscale serve config for https://${hostname} (stays after exit)`);
  }
  if (launched && version !== "dev") pruneVersions(versionsDir(), version);
  // The QR (for a phone) gets the first non-loopback URL.
  const urls = [...(hostname ? [`https://${hostname}`] : []), ...lanIps.map((ip) => `http://${ip}:${actual}`), `http://127.0.0.1:${actual}`].map((u) => pairingUrl(u, token));
  // The pairing URLs are the one place the token is printed; keep it out of every other log line.
  console.log(
    `claude-ui daemon on ${lan ? `port ${actual} of every network interface (--lan)` : `http://127.0.0.1:${actual}`}, roots: ${roots.join(delimiter)}${distros.length ? `, WSL: ${distros.join(", ")}` : ""}` +
      (lan ? "\nLAN mode: plain HTTP, anyone on this network can read the token while you pair or use it. Browser push notifications, Copy and installing the app (Add to Home Screen) need HTTPS: use --tailscale" + (osNotify === false ? "." : "; this machine shows desktop notifications instead (no browser subscribed).") : "") +
      `\nPair a browser: open ${urls.join("\n  or ")}` +
      (hostname ? `\n${PHONE_HINT}` : "") +
      `\n${await QRCode.toString(urls[0]!, { type: "terminal", small: true })}`,
  );
  // This machine's browser gets the loopback pairing URL (always the last); a failing opener only leaves the link above to click.
  if (open !== false && autoOpen(process.env, process.platform, process.platform === "linux" && /microsoft/i.test(release())))
    openInBrowser(urls.at(-1)!).catch((e: Error) => console.error(`claude-ui: could not open a browser (${e.message}); open the link above`));
});

/** The package folder (has dist/cli.js) a WSL or Docker side installs; a new build gets a new key, so the side installs it again. */
function sidePackageDir() {
  return folderPath(existsSync(bundledWeb) ? new URL("..", import.meta.url) : new URL("../../claude-ui", import.meta.url));
}
function sideKeyOf(dir: string) {
  try {
    return `${version}-${Math.trunc(statSync(join(dir, "dist", "cli.js")).mtimeMs)}`;
  } catch {
    return version;
  }
}

/** A spawn failure (ENOENT) emits 'error' and no 'exit': report it as an exit, once. */
function sideChild(child: ChildProcess): SideProcess {
  let exited = false;
  child.once("exit", () => (exited = true));
  child.on("error", (e) => {
    child.stderr?.emit("data", Buffer.from(e.message));
    if (!exited) (exited = true), child.emit("exit", null);
  });
  return child as unknown as SideProcess;
}

/** Whether the docker CLI is on PATH (the engine may be down: discovery then finds no containers). */
function dockerCli() {
  try {
    execFileSync("docker", ["--version"], { timeout: 5_000, windowsHide: true, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Whether the ssh command is on PATH (`ssh -V` prints to stderr; no ssh: no SSH Sides, no error). */
function sshCli() {
  try {
    execFileSync("ssh", ["-V"], { timeout: 5_000, windowsHide: true, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** The installed WSL distros; none when WSL is not installed. */
function wslDistros() {
  try {
    return parseDistros(execFileSync("wsl.exe", ["-l", "-q"], { timeout: 10_000, windowsHide: true }));
  } catch {
    return [];
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}
