import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { homedir, networkInterfaces, release } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { HELP, PHONE_HINT, USAGE_HINT, autoOpen, parseCli } from "./cli.ts";
import { createSettings } from "./settings.ts";
import { createSecrets } from "./secrets.ts";
import { createProjects } from "./projects.ts";
import { createPush, type Push } from "./push.ts";
import { createDaemon } from "./server.ts";
import { sideCacheDir } from "./side-bundle.ts";
import { checkDockerSide, dockerStatus, execRun, folderPath, prepareDockerSide } from "./docker-side.ts";
import { runGit, setGitRunner, threadRunner } from "./git-runner.ts";
import { wslGitRunner } from "./wsl-git.ts";
import { prepareWslSide } from "./wsl-side.ts";
import { checkWslSide, createSides, dockerExecArgs, forwardSidePush, dockerSide, parseDistros, runSide, setupScript, wslArgs, wslSide, type SideProcess } from "./sides.ts";
import type { DockerState, SidePhase, SideSetup } from "@claude-ui/protocol";
import { exitOnSignal, logExit } from "./exit-log.ts";
import { readProcessTable, watchChain, wrapperChain } from "./ancestors.ts";
import { startServe, tailscalePreflight } from "./tailscale.ts";
import { openInBrowser, runClient } from "./ctl/commands.ts";
import { claimDaemonFile } from "./ctl/daemon-file.ts";
import { configDir, loadToken, pairingUrl } from "./token.ts";
import { defaultUploadsDir } from "./uploads.ts";
import { installVersion, latestNewer, parseRegistry, pruneVersions, versionsDir } from "./update.ts";
import { createBuildInfo } from "./build-info.ts";

const cli = parseCli(process.argv.slice(2), process.env, homedir());
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
const { port, roots, lan, allowBypass, idleCloseMinutes, side, updateCheck, osNotify, tailscale, open } = cli;
let hostname = cli.hostname;
// ponytail: LAN addresses are read once at start; an address the network assigns later is refused until a restart.
const lanIps = lan ? Object.values(networkInterfaces()).flat().filter((a) => a && a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")).map((a) => a!.address) : [];
// The installed package ships the web build as dist/web beside this file; a source checkout builds packages/web/dist.
const bundledWeb = new URL("./web", import.meta.url);
const webRoot = fileURLToPath(existsSync(bundledWeb) ? bundledWeb : new URL("../../web/dist", import.meta.url));
const state = { uploadDir: defaultUploadsDir(), settingsFile: join(configDir(), "sessions.json"), projects: createProjects({ file: join(configDir(), "projects.json") }), appSettings: createSettings({ file: join(configDir(), "settings.json") }), secrets: createSecrets({ file: join(configDir(), "secrets.json") }) };

if (side) {
  // A fresh container has no ~/.config: the hub's loadToken creates the config dir, a side has none.
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  // stdout carries the frames: every log line goes to stderr.
  console.log = console.error;
  let push: (p: Parameters<Push["send"]>[0]) => void = () => {};
  const sidePush = { publicKey: "", subscribe: () => false, send: async (p) => push(p) } satisfies Push;
  const daemon = createDaemon({ webRoot, token: "", roots, push: sidePush, allowBypass, idleCloseMs: idleCloseMinutes * 60_000, ...state });
  push = runSide({ input: process.stdin, output: process.stdout, accept: daemon.accept, git: runGit, onEnd: () => process.exit(0) }).push;
} else {
  const token = loadToken();
  const sidesFile = join(configDir(), "sides.json");
  const push = createPush({ desktop: () => state.appSettings.get().notifications.desktop, ...(osNotify === false && { notify: false as const }) });
  const distros = process.platform === "win32" ? wslDistros() : [];
  const sidePackage = sidePackageDir();
  const sideKey = () => sideKeyOf(sidePackage);
  const docker = dockerCli();
  /** Docker side: the container must run and gets the bundle (or this package for npm), then `docker exec -i <name> sh -c <setup script>`. */
  const spawnDocker = async (name: string, setup: SideSetup, onPhase: (p: SidePhase) => void, onInstall?: (i: { bundle: true } | { fallback: string }) => void, pinned?: boolean): Promise<SideProcess> => {
    const key = sideKey();
    const sent = await prepareDockerSide({ name, pkgDir: sidePackage, key, cacheDir: join(configDir(), "side-pack"), setup, pinned, onPhase, onInstall, bundle: { cacheRoot: sideCacheDir(), version, registry } });
    return sideChild(spawn("docker", dockerExecArgs(name, setupScript(sent.path, key, "docker", setup, sent.bundle)), { stdio: "pipe", windowsHide: true }));
  };
  /** WSL side: a covered distro installs from the host's verified cached parts read through /mnt (no npm, network or compile in the distro), else from npm. */
  const spawnWsl = async (distro: string, setup: SideSetup, onPhase: (p: SidePhase) => void, onInstall?: (i: { bundle: true } | { fallback: string }) => void, pinned?: boolean): Promise<SideProcess> => {
    const bundle = await prepareWslSide({ distro, pkgDir: sidePackage, setup, pinned, onPhase, onInstall, bundle: { cacheRoot: sideCacheDir(), version, registry } });
    return sideChild(spawn("wsl.exe", wslArgs(distro, setupScript(sidePackage, sideKey(), "wsl", setup, bundle)), { stdio: "pipe", windowsHide: true }));
  };
  let dockerState: DockerState | undefined;
  const sides =
    distros.length || docker
      ? createSides({
          targets: distros.map(wslSide),
          localLabel: process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux",
          posixLocal: process.platform !== "win32",
          localDirs: [homedir(), ...roots].flatMap((p) => [p, realOr(p)]),
          ...(docker && { discover: async () => {
              const s = await dockerStatus();
              dockerState = s.state;
              return s.containers.map(dockerSide);
            },
            dockerState: () => dockerState,
          }),
          // This claude-ui's own package runs in the side: the installed package, or packages/claude-ui of a source checkout (npm start builds it).
          spawn: (id, { setup, phase, install, pinned }) => (id.startsWith("docker:") ? spawnDocker(id.slice("docker:".length), setup, phase, install, pinned) : spawnWsl(id.slice("wsl:".length), setup, phase, install, pinned)),
          // side.check: read-only (docker inspect + one docker exec, or one wsl.exe run of the check script).
          key: sideKey,
          check: (id) => (id.startsWith("docker:") ? checkDockerSide({ name: id.slice("docker:".length), pkgDir: sidePackage, key: sideKey() }) : checkWslSide({ distro: id.slice("wsl:".length), pkgDir: sidePackage, key: sideKey(), exec: execRun })),
          onPush: forwardSidePush(push),
          saved: readSaved(sidesFile),
          save: (ids) => writeFileSync(sidesFile, JSON.stringify(ids)),
        })
      : undefined;
  void sides?.refresh();
  // A project opened by its \\wsl$ path: git runs in the distro (its ready side, else wsl.exe), never Windows git over the UNC path.
  if (process.platform === "win32") setGitRunner(wslGitRunner({ local: threadRunner, ...(sides && { side: sides.wslReady, sideRun: sides.git }) }));
  const tsEnv = { ...process.env, TAILSCALE_BE_CLI: "1" };
  const exec = promisify(execFile);
  const ts = tailscale ? await tailscalePreflight({ port, platform: process.platform, env: process.env, exec: (f, a) => exec(f, a, { timeout: 10_000, windowsHide: true, env: tsEnv }) }) : undefined;
  if (ts && "error" in ts) (console.error(`claude-ui: ${ts.error}`), process.exit(1));
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
  const update = updateCheck !== false && version !== "dev" && launched ? { current: version, dir: versionsDir(), registry, exit: (code: number) => void setTimeout(() => process.exit(code), 200) } : undefined;
  // A source checkout compares its files with the start; a release compares its version with the installed ones (build-info.ts).
  const buildInfo = createBuildInfo({ version, srcDirs: [fileURLToPath(new URL("../src", import.meta.url)), fileURLToPath(new URL("../../protocol/src", import.meta.url))], versionsDir: versionsDir() });
  const server = createDaemon({ webRoot, token, roots, push, allowBypass, idleCloseMs: idleCloseMinutes * 60_000, ...state, hostnames, sides, update, buildInfo, desktopForcedOff: osNotify === false, warmUp: true });
  // The Aside leftover probe of other daemons connects to 127.0.0.1: keep binding 127.0.0.1 or 0.0.0.0, never another address.
  server.listen(port, lan ? "0.0.0.0" : "127.0.0.1", async () => {
    // Where this daemon listens, for the client commands (no token in it); gone with the process.
    const dir = configDir();
    try {
      process.on("exit", claimDaemonFile(dir, { port: (server.address() as AddressInfo).port, pid: process.pid, version, startedAt: new Date().toISOString() }));
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
    const urls = [...(hostname ? [`https://${hostname}`] : []), ...lanIps.map((ip) => `http://${ip}:${port}`), `http://127.0.0.1:${port}`].map((u) => pairingUrl(u, token));
    // The pairing URLs are the one place the token is printed; keep it out of every other log line.
    console.log(
      `claude-ui daemon on ${lan ? `port ${port} of every network interface (--lan)` : `http://127.0.0.1:${port}`}, roots: ${roots.join(delimiter)}${distros.length ? `, WSL: ${distros.join(", ")}` : ""}` +
        (lan ? "\nLAN mode: plain HTTP, anyone on this network can read the token while you pair or use it. Browser push notifications, Copy and installing the app (Add to Home Screen) need HTTPS: use --tailscale" + (osNotify === false ? "." : "; this machine shows desktop notifications instead (no browser subscribed).") : "") +
        `\nPair a browser: open ${urls.join("\n  or ")}` +
        (hostname ? `\n${PHONE_HINT}` : "") +
        `\n${await QRCode.toString(urls[0]!, { type: "terminal", small: true })}`,
    );
    // This machine's browser gets the loopback pairing URL (always the last); a failing opener only leaves the link above to click.
    if (open !== false && autoOpen(process.env, process.platform, process.platform === "linux" && /microsoft/i.test(release())))
      openInBrowser(urls.at(-1)!).catch((e: Error) => console.error(`claude-ui: could not open a browser (${e.message}); open the link above`));
  });
}

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

/** The installed WSL distros; none when WSL is not installed. */
function wslDistros() {
  try {
    return parseDistros(execFileSync("wsl.exe", ["-l", "-q"], { timeout: 10_000, windowsHide: true }));
  } catch {
    return [];
  }
}

function readSaved(file: string): string[] {
  try {
    const ids = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(ids) ? ids.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
