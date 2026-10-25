import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gitLog, gitRefs } from "../src/git.ts";
import { setGitRunner, threadRunner, type GitRunOptions } from "../src/git-runner.ts";
import { endProcessTrees } from "../src/git-runner.ts";
import { FETCH_ARGS, gitBranch, gitFetch, gitPull, gitPush, localRemotePath, redactUrls, remoteConfig, tidy } from "../src/git-remote.ts";

if (process.platform === "win32") vi.setConfig({ testTimeout: 120_000 });
const posix = process.platform !== "win32";
const run = (cwd: string, ...args: string[]) => {
  const env = { ...process.env };
  delete env.GIT_DIR;
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
};
const commit = (dir: string, m: string) => run(dir, "commit", "-q", "--allow-empty", "-m", m);

/** A bare remote r.git (local file path) and two clones a and b. */
function remoteRepo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grem-")));
  run(root, "init", "-q", "--bare", "-b", "main", "r.git");
  run(root, "clone", "-q", "r.git", "a");
  const a = join(root, "a");
  commit(a, "c1");
  run(a, "push", "-q", "-u", "origin", "main");
  run(root, "clone", "-q", "r.git", "b");
  const b = join(root, "b");
  const inside = (p: string) => p.startsWith(root);
  return { root, a, b, inside };
}
const newBranch = (b: string, name: string) => {
  run(b, "checkout", "-q", "-b", name);
  commit(b, name);
  run(b, "push", "-q", "origin", name);
};

afterEach(() => {
  setGitRunner(undefined);
  remoteConfig.timeout = 120_000;
  vi.unstubAllEnvs();
});

describe("gitFetch", () => {
  it("brings a new remote branch into the branch list and the graph", async () => {
    const { a, b, inside } = remoteRepo();
    newBranch(b, "feat");
    const before = await gitRefs(a, inside);
    const r = await gitFetch(a, { allowed: inside });
    expect(r?.output).toMatch(/feat\s+-> origin\/feat/);
    expect(r?.refs).not.toBe(before);
    expect(r?.refs).toBe(await gitRefs(a, inside));
    const log = await gitLog(a, { allowed: inside, fresh: true });
    expect(log?.branches).toContain("refs/remotes/origin/feat");
  });

  it("is null outside a repository and refuses a top outside the roots", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "nogit-")));
    expect(await gitFetch(dir, { allowed: () => true })).toBeNull();
    const { a } = remoteRepo();
    await expect(gitFetch(a, { allowed: () => false })).rejects.toMatchObject({ code: "cwd_not_allowed" });
  });

  it("shows git's message for a failure, without credentials in the URL", async () => {
    const { a, inside } = remoteRepo();
    run(a, "remote", "remove", "origin");
    run(a, "remote", "add", "bad", "https://user:secret@127.0.0.1:9/x.git");
    const e = await gitFetch(a, { allowed: inside }).then(() => undefined, (x: Error & { code?: string }) => x);
    expect(e).toMatchObject({ code: "git_failed" });
    expect(e!.message).toContain("127.0.0.1");
    expect(e!.message).not.toContain("secret");
    expect(e!.message).not.toContain("user:");
  });

  it("refuses a remote that is a folder outside the roots before git runs", async () => {
    const { root, a } = remoteRepo();
    const calls: string[] = [];
    setGitRunner((o) => (calls.push(o.args.includes("fetch") ? "fetch" : o.args[0]!), threadRunner(o)));
    await expect(gitFetch(a, { allowed: (p) => p.startsWith(join(root, "a")) })).rejects.toMatchObject({ code: "remote_not_allowed" });
    expect(calls).not.toContain("fetch");
  });

  it.each(["//host/share/r.git", "\\\\host\\share\\r.git", "file://host/share/r.git", "//?/C:/r.git"])("on Windows refuses the foreign remote %s without any file call on it", async (url) => {
    const { a, inside } = remoteRepo();
    run(a, "remote", "set-url", "origin", url);
    const seen: string[] = [];
    const allowed = (p: string) => (seen.push(p), inside(p));
    const calls: string[] = [];
    setGitRunner((o) => (calls.push(o.args.includes("fetch") ? "fetch" : o.args[0]!), threadRunner(o)));
    await expect(gitFetch(a, { allowed, platform: "win32" })).rejects.toMatchObject({ code: "remote_not_allowed" });
    // `allowed` only ever gets the repository's own paths: `real()` of the remote was never called.
    expect(seen.filter((p) => /host|share|\?/.test(p) && !p.startsWith(a) && !p.startsWith(realpathSync(a)))).toEqual([]);
    expect(calls).not.toContain("fetch");
  });

  it("refuses a repository whose .git points outside the roots", async () => {
    const { root, a } = remoteRepo();
    const outer = realpathSync(mkdtempSync(join(tmpdir(), "outer-")));
    const roots = (p: string) => p.startsWith(root) && !p.startsWith(outer);
    const calls: string[] = [];
    setGitRunner((o) => (calls.push(o.args.includes("fetch") ? "fetch" : o.args[0]!), threadRunner(o)));
    // alternates outside the roots
    writeFileSync(join(a, ".git", "objects", "info", "alternates"), `${join(outer, "objects")}\n`);
    await expect(gitFetch(a, { allowed: roots })).rejects.toMatchObject({ code: "cwd_not_allowed" });
    writeFileSync(join(a, ".git", "objects", "info", "alternates"), "# none\n");
    // gitdir file to a git dir outside the roots
    run(root, "clone", "-q", "r.git", join(outer, "c"));
    const w = join(root, "w");
    mkdirSync(w);
    writeFileSync(join(w, ".git"), `gitdir: ${join(outer, "c", ".git")}\n`);
    await expect(gitFetch(w, { allowed: roots })).rejects.toMatchObject({ code: "cwd_not_allowed" });
    expect(calls).toEqual([]);
  });

  it("reports no remote", async () => {
    const { a, inside } = remoteRepo();
    run(a, "remote", "remove", "origin");
    await expect(gitFetch(a, { allowed: inside })).rejects.toMatchObject({ code: "bad_request" });
  });

  it("never prompts: GIT_TERMINAL_PROMPT=0, empty askpass, GCM never, BatchMode ssh unless the user has an ssh command", async () => {
    vi.stubEnv("GIT_SSH_COMMAND", undefined as unknown as string);
    vi.stubEnv("GIT_SSH", undefined as unknown as string);
    const { a, inside } = remoteRepo();
    const envs: NodeJS.ProcessEnv[] = [];
    setGitRunner((o) => (o.args.includes("fetch") && envs.push(o.env), threadRunner(o)));
    await gitFetch(a, { allowed: inside });
    expect(envs[0]).toMatchObject({ GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "", GCM_INTERACTIVE: "never", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" });
    run(a, "config", "core.sshCommand", "ssh -i k");
    await gitFetch(a, { allowed: inside });
    expect(envs[1]!.GIT_SSH_COMMAND).toBeUndefined();
  });

  it.skipIf(!posix)("runs ssh with BatchMode=yes", async () => {
    vi.stubEnv("GIT_SSH_COMMAND", undefined as unknown as string);
    vi.stubEnv("GIT_SSH", undefined as unknown as string);
    const { root, a, inside } = remoteRepo();
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "ssh"), `#!/bin/sh\necho "$@" > ${join(root, "ssh.args")}\nexit 255\n`);
    chmodSync(join(bin, "ssh"), 0o755);
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    run(a, "remote", "remove", "origin");
    run(a, "remote", "add", "s", "ssh://example.invalid/r.git");
    await expect(gitFetch(a, { allowed: inside })).rejects.toMatchObject({ code: "git_failed" });
    expect(existsSync(join(root, "ssh.args"))).toBe(true);
    expect(execFileSync("cat", [join(root, "ssh.args")], { encoding: "utf8" })).toContain("BatchMode=yes");
  });

  it.skipIf(!posix)("times out with a clear error when the remote never answers", async () => {
    vi.stubEnv("GIT_SSH_COMMAND", undefined as unknown as string);
    vi.stubEnv("GIT_SSH", undefined as unknown as string);
    const { root, a, inside } = remoteRepo();
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "ssh"), "#!/bin/sh\nexec sleep 30\n");
    chmodSync(join(bin, "ssh"), 0o755);
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    run(a, "remote", "remove", "origin");
    run(a, "remote", "add", "s", "ssh://example.invalid/r.git");
    remoteConfig.timeout = 1500;
    await expect(gitFetch(a, { allowed: inside })).rejects.toThrow(/timed out after/);
  });

  it("answers a second remote operation on the same repository (or a linked worktree) with busy", async () => {
    const { a, root, inside } = remoteRepo();
    run(a, "worktree", "add", "-q", join(root, "wt"), "-b", "wtb");
    setGitRunner((o) => (o.args.includes("fetch") ? new Promise((r) => setTimeout(r, 400)).then(() => threadRunner(o)) : threadRunner(o)));
    const first = gitFetch(a, { allowed: inside });
    await new Promise((r) => setTimeout(r, 100));
    await expect(gitFetch(a, { allowed: inside })).rejects.toMatchObject({ code: "busy" });
    await expect(gitFetch(join(root, "wt"), { allowed: inside })).rejects.toMatchObject({ code: "busy" });
    await expect(first).resolves.toBeTruthy();
    await expect(gitFetch(a, { allowed: inside })).resolves.toBeTruthy();
  });

  it.skipIf(!posix)("does not disable hooks: a reference-transaction hook runs on fetch", async () => {
    const { root, a, b, inside } = remoteRepo();
    const hook = join(a, ".git", "hooks", "reference-transaction");
    writeFileSync(hook, `#!/bin/sh\ntouch ${join(root, "hook.ran")}\n`);
    chmodSync(hook, 0o755);
    newBranch(b, "hooked");
    await gitFetch(a, { allowed: inside });
    expect(existsSync(join(root, "hook.ran"))).toBe(true);
    rmSync(hook);
  });
});

/** Running: a killed process that init has not reaped yet (zombie) does not count. */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (f: () => boolean, ms = 3000) => {
  for (let t = 0; t < ms && !f(); t += 25) await new Promise((r) => setTimeout(r, 25));
};

describe("gitFetch process control", () => {
  it("fetch runs without fsmonitor and ext transport and leaves submodules alone", async () => {
    const { a, inside } = remoteRepo();
    const argv: string[][] = [];
    setGitRunner((o) => (o.args.includes("fetch") && argv.push(o.args), threadRunner(o)));
    await gitFetch(a, { allowed: inside });
    expect(argv[0]).toEqual(["-c", "core.fsmonitor=false", "-c", "protocol.ext.allow=never", "fetch", "--all", "--no-recurse-submodules"]);
    expect(FETCH_ARGS).toEqual(argv[0]);
  });

  it.skipIf(!posix)("a timeout kills the ssh child too and the lock is kept until it is gone", async () => {
    vi.stubEnv("GIT_SSH_COMMAND", undefined as unknown as string);
    vi.stubEnv("GIT_SSH", undefined as unknown as string);
    const { root, a, inside } = remoteRepo();
    const script = join(root, "slowssh");
    writeFileSync(script, `#!/bin/sh\necho $$ >> ${join(root, "pids")}\nexec sleep 30\n`);
    chmodSync(script, 0o755);
    run(a, "config", "core.sshCommand", script);
    run(a, "remote", "remove", "origin");
    run(a, "remote", "add", "s1", "ssh://example.invalid/r.git");
    run(a, "remote", "add", "s2", "ssh://example.invalid/r2.git");
    remoteConfig.timeout = 1500;
    const first = gitFetch(a, { allowed: inside }).then(() => undefined, (e: Error) => e);
    await until(() => existsSync(join(root, "pids")));
    expect(existsSync(join(root, "pids"))).toBe(true);
    await expect(gitFetch(a, { allowed: inside })).rejects.toMatchObject({ code: "busy" });
    const e = await first;
    expect(e?.message).toMatch(/timed out after/);
    const pids = readFileSync(join(root, "pids"), "utf8").split("\n").filter(Boolean).map(Number);
    expect(pids.length).toBeGreaterThan(0);
    // The call settled only after the group ended: no ssh survives, and the lock is free again.
    await until(() => !pids.some(alive));
    expect(pids.some(alive)).toBe(false);
    remoteConfig.timeout = 120_000;
    run(a, "remote", "remove", "s1");
    run(a, "remote", "remove", "s2");
    run(a, "config", "--unset", "core.sshCommand");
    run(a, "remote", "add", "origin", join(root, "r.git"));
    await expect(gitFetch(a, { allowed: inside })).resolves.toBeTruthy();
  });

  it.skipIf(!posix)("the daemon ending kills the groups of running remote calls on the worker-thread runner", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "grem-")));
    const pidFile = join(root, "pid");
    const p = threadRunner({ cwd: root, args: ["-c", `echo $$ > ${pidFile}; exec sleep 30`], file: "sh", env: process.env, timeout: 60_000, killTree: true }).then(() => undefined, (e: Error) => e);
    await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
    const pid = Number(readFileSync(pidFile, "utf8"));
    await new Promise((r) => setTimeout(r, 100));
    expect(alive(pid)).toBe(true);
    endProcessTrees();
    await until(() => !alive(pid));
    expect(alive(pid)).toBe(false);
    await p;
  });

  it("refuses a WSL project with a clear message", async () => {
    await expect(gitFetch("\\\\wsl$\\Ubuntu\\home\\u\\p", { allowed: () => true })).rejects.toMatchObject({ code: "bad_request", message: "Fetch is not supported for WSL projects yet" });
  });

  it("the lock is free after a failed fetch and after a runner that rejects", async () => {
    const { a, inside } = remoteRepo();
    setGitRunner((o) => (o.args.includes("fetch") ? Promise.reject(Object.assign(new Error("boom"), { stderr: "fatal: nope" })) : threadRunner(o)));
    await expect(gitFetch(a, { allowed: inside })).rejects.toMatchObject({ code: "git_failed" });
    setGitRunner((o) => (o.args.includes("fetch") ? Promise.reject(new Error("weird")) : threadRunner(o)));
    await expect(gitFetch(a, { allowed: inside })).rejects.toThrow();
    setGitRunner(undefined);
    await expect(gitFetch(a, { allowed: inside })).resolves.toBeTruthy();
  });
});

describe("localRemotePath", () => {
  it("resolves local remotes against the top and ignores network URLs", () => {
    expect(localRemotePath("/x/r.git", "/y/a")).toBe("/x/r.git");
    if (posix) expect(localRemotePath("../r.git", "/x/a")).toBe("/x/r.git");
    if (posix) expect(localRemotePath("file:///x/r.git", "/y/a")).toBe("/x/r.git");
    expect(localRemotePath("file::/x/r", "/y/a")).toBe("/x/r");
    expect(localRemotePath("C:\\r.git", "/y/a")).toBe("C:\\r.git");
    expect(localRemotePath("git@github.com:o/r.git", "/y/a")).toBeUndefined();
    expect(localRemotePath("https://h/r", "/y/a")).toBeUndefined();
    expect(localRemotePath("ssh://h/r", "/y/a")).toBeUndefined();
    expect(localRemotePath("ext::sh -c x", "/y/a")).toBeUndefined();
  });
  it("treats a malformed file URL as a path to refuse", () => {
    // Windows reads `file://host/x` as the UNC path \\host\x, which checkRemotes refuses as another host (foreignPointer).
    expect(localRemotePath("file://host/x", "/y/a")).toBe(process.platform === "win32" ? "\\\\host\\x" : "");
  });
});

describe("tidy", () => {
  it("collapses progress lines, removes userinfo and keeps the tail", () => {
    expect(tidy("a\rb\rc\nx", 100)).toBe("c\nx");
    expect(tidy("https://u:p@h/x", 100)).toBe("https://h/x");
    expect(tidy("0123456789", 4)).toBe("6789");
  });
});

describe("redactUrls", () => {
  it("removes userinfo with and without a scheme, keeps scp-like users readable", () => {
    expect(redactUrls("fatal: unable to look up bob:pw9x@127.0.0.1:9 (port 9)")).toBe("fatal: unable to look up 127.0.0.1:9 (port 9)");
    expect(redactUrls("fatal: unable to look up git://bob:pw9x@127.0.0.1:9/x.git")).not.toMatch(/bob|pw9x/);
    expect(redactUrls("http://user:pass@h/x")).toBe("http://h/x");
    expect(redactUrls("ssh://user@h")).toBe("ssh://h");
    expect(redactUrls("https://TOKEN@h/x")).toBe("https://h/x");
    expect(redactUrls("From git@github.com:o/r.git")).toBe("From git@github.com:o/r.git");
    expect(redactUrls("git@github.com: Permission denied (publickey).")).toBe("git@github.com: Permission denied (publickey).");
    expect(redactUrls("bob:pw@host.example:o/r.git")).toBe("bob@host.example:o/r.git");
    expect(redactUrls("unable to look up TOKEN@h:9")).toBe("unable to look up h:9");
    expect(redactUrls("unable to look up TOKEN@h")).toBe("unable to look up h");
  });
  it("covers passwords with quotes, slashes and angle brackets", () => {
    expect(redactUrls("look up bob:p'w@host.example:9")).toBe("look up host.example:9");
    expect(redactUrls("look up bob:p/w@host.example:9")).toBe("look up host.example:9");
    expect(redactUrls("look up bob:p<w@host.example:9")).toBe("look up host.example:9");
    expect(redactUrls("fatal: 'bob:p'w@host.example:9' failed")).not.toMatch(/bob|p'w/);
    expect(redactUrls("bob:p/w@host.example:o/r.git")).toBe("bob@host.example:o/r.git");
    expect(redactUrls("From git@host.example:o/r.git")).toBe("From git@host.example:o/r.git");
  });
  it("the thrown message of a failing fetch has no userinfo", async () => {
    const { a, inside } = remoteRepo();
    run(a, "remote", "remove", "origin");
    run(a, "remote", "add", "bad", "git://bob:pw9x@127.0.0.1:9/x.git");
    const e = await gitFetch(a, { allowed: inside }).then(() => undefined, (x: Error) => x);
    expect(e).toBeDefined();
    expect(e!.message).not.toMatch(/bob|pw9x/);
  });
});

// A superproject whose submodule has its own remote; both remotes moved ahead of the clones.
const PROTO = ["-c", "protocol.file.allow=always"];
function superWithSub() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsub-")));
  const cfg = join(root, "gitconfig");
  writeFileSync(cfg, '[submodule]\n\trecurse = true\n[fetch]\n\trecurseSubmodules = true\n[protocol "file"]\n\tallow = always\n');
  vi.stubEnv("GIT_CONFIG_GLOBAL", cfg);
  run(root, "init", "-q", "--bare", "-b", "main", "lib.git");
  run(root, "init", "-q", "--bare", "-b", "main", "super.git");
  run(root, "clone", "-q", "lib.git", "libA");
  commit(join(root, "libA"), "lib c1");
  run(join(root, "libA"), "push", "-q", "origin", "main");
  run(root, "clone", "-q", "super.git", "sup");
  const sup = join(root, "sup");
  commit(sup, "super c1");
  run(sup, ...PROTO, "submodule", "add", "-q", join(root, "lib.git"), "libs/lib");
  run(sup, "commit", "-q", "-m", "add lib");
  run(sup, "push", "-q", "-u", "origin", "main");
  const sub = join(sup, "libs", "lib");
  const libC1 = run(sub, "rev-parse", "HEAD");
  // The submodule's remote moves.
  commit(join(root, "libA"), "lib c2");
  run(join(root, "libA"), "push", "-q", "origin", "main");
  const libC2 = run(join(root, "libA"), "rev-parse", "HEAD");
  // The superproject's remote moves and points at the new submodule commit.
  run(root, "clone", "-q", "super.git", "supB");
  const supB = join(root, "supB");
  run(supB, ...PROTO, "submodule", "update", "--init", "-q");
  run(join(supB, "libs", "lib"), "fetch", "-q", "origin");
  run(join(supB, "libs", "lib"), "checkout", "-q", libC2);
  run(supB, "commit", "-q", "-am", "move lib");
  run(supB, "push", "-q", "origin", "main");
  const supTip = run(supB, "rev-parse", "HEAD");
  const tracking = (repo: string) => run(repo, "rev-parse", "refs/remotes/origin/main");
  return { root, sup, sub, supB, libC1, libC2, supTip, tracking, inside: (p: string) => p.startsWith(root) };
}

describe("remote operations per repository (GH-391)", () => {
  it.skipIf(!posix)("with the user's submodule.recurse and fetch.recurseSubmodules, a superproject fetch does not enter the submodule", async () => {
    const f = superWithSub();
    // Control: the same config makes a plain `git fetch` of a second clone recurse.
    run(f.root, ...PROTO, "clone", "-q", "--recurse-submodules", "super.git", "supC");
    const subC = join(f.root, "supC", "libs", "lib");
    run(subC, "update-ref", "-d", "refs/remotes/origin/main");
    run(join(f.root, "supC"), "fetch", "-q");
    const recursed = run(subC, "rev-parse", "--verify", "-q", "refs/remotes/origin/main");
    expect(recursed).toBe(f.libC2);
    const argv: string[][] = [];
    setGitRunner((o) => (o.args.includes("fetch") && argv.push(o.args), threadRunner(o)));
    await gitFetch(f.sup, { allowed: f.inside });
    expect(f.tracking(f.sup)).toBe(f.supTip);
    expect(f.tracking(f.sub)).toBe(f.libC1);
    expect(argv[0]).toContain("--no-recurse-submodules");
  });

  it.skipIf(!posix)("a superproject pull does not update or fetch the submodule", async () => {
    const f = superWithSub();
    const ref = "refs/heads/main";
    const info = await gitBranch(f.sup, ref, { allowed: f.inside });
    expect(info?.pull).toContain("--no-recurse-submodules");
    await gitPull(f.sup, { ref, local: info!.local, argv: info!.pull!, allowed: f.inside });
    expect(run(f.sup, "rev-parse", "HEAD")).toBe(f.supTip);
    expect(run(f.sub, "rev-parse", "HEAD")).toBe(f.libC1);
    expect(f.tracking(f.sub)).toBe(f.libC1);
  });

  it.skipIf(!posix)("fetching the submodule itself fetches only its remotes", async () => {
    const f = superWithSub();
    await gitFetch(f.sub, { allowed: f.inside });
    expect(f.tracking(f.sub)).toBe(f.libC2);
    expect(f.tracking(f.sup)).not.toBe(f.supTip);
  });

  it.skipIf(!posix)("a nested repository or submodule whose remote is a local folder outside the roots is remote_not_allowed", async () => {
    const f = superWithSub();
    const other = realpathSync(mkdtempSync(join(tmpdir(), "gout-")));
    run(other, "init", "-q", "--bare", "-b", "main", "x.git");
    run(f.sub, "remote", "set-url", "origin", join(other, "x.git"));
    await expect(gitFetch(f.sub, { allowed: f.inside })).rejects.toMatchObject({ code: "remote_not_allowed" });
    const inner = join(f.sup, "tools", "inner");
    run(f.sup, "init", "-q", "-b", "main", "tools/inner");
    commit(inner, "inner c1");
    run(inner, "remote", "add", "origin", join(other, "x.git"));
    await expect(gitFetch(inner, { allowed: f.inside })).rejects.toMatchObject({ code: "remote_not_allowed" });
    const ref = "refs/heads/main";
    run(f.sub, "checkout", "-q", "-B", "main");
    run(f.sub, "config", "branch.main.remote", "origin");
    run(f.sub, "config", "branch.main.merge", ref);
    const info = await gitBranch(f.sub, ref, { allowed: f.inside });
    if (info?.push) await expect(gitPush(f.sub, { ref, local: info.local, argv: info.push, allowed: f.inside })).rejects.toMatchObject({ code: "remote_not_allowed" });
    expect(info?.push).toBeTruthy();
  });

  it.skipIf(!posix)("fetches of a superproject and its submodule run at once; two on the same repository are busy", async () => {
    const f = superWithSub();
    // Each fetch waits in the runner until the test releases it: no timing involved.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started = 0;
    setGitRunner((o) => (o.args.includes("fetch") ? (started++, gate.then(() => threadRunner(o))) : threadRunner(o)));
    const until2 = async () => {
      for (let i = 0; i < 400 && started < 2; i++) await new Promise((r) => setTimeout(r, 10));
    };
    const a = gitFetch(f.sup, { allowed: f.inside });
    const b = gitFetch(f.sub, { allowed: f.inside });
    await until2();
    // Both reached their runner at the same time: neither lock blocked the other.
    expect(started).toBe(2);
    await expect(gitFetch(f.sub, { allowed: f.inside })).rejects.toMatchObject({ code: "busy" });
    await expect(gitFetch(f.sup, { allowed: f.inside })).rejects.toMatchObject({ code: "busy" });
    release();
    await expect(a).resolves.toBeTruthy();
    await expect(b).resolves.toBeTruthy();
  });

  const WSL = "\\\\wsl$\\Ubuntu\\home\\u\\p\\libs\\lib";
  it.each([
    ["gitFetch", () => gitFetch(WSL, { allowed: () => true })],
    ["gitBranch", () => gitBranch(WSL, "refs/heads/main", { allowed: () => true })],
    ["gitPush", () => gitPush(WSL, { ref: "refs/heads/main", local: "a".repeat(40), argv: [], allowed: () => true })],
    ["gitPull", () => gitPull(WSL, { ref: "refs/heads/main", local: "a".repeat(40), argv: [], allowed: () => true })],
  ])("%s of a nested WSL repository is refused", async (_n, call) => {
    await expect(call()).rejects.toMatchObject({ code: "bad_request", message: expect.stringMatching(/not supported for WSL projects/) });
  });
});
