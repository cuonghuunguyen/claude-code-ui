import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gitLog, gitRefs } from "../src/git.ts";
import { setGitRunner, threadRunner, type GitRunOptions } from "../src/git-runner.ts";
import { gitFetch, localRemotePath, redactUrls, remoteConfig, tidy } from "../src/git-remote.ts";

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
    const before = gitRefs(a);
    const r = await gitFetch(a, { allowed: inside });
    expect(r?.output).toMatch(/feat\s+-> origin\/feat/);
    expect(r?.refs).not.toBe(before);
    expect(r?.refs).toBe(gitRefs(a));
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
    setGitRunner((o) => (calls.push(o.args[0]!), threadRunner(o)));
    await expect(gitFetch(a, { allowed: (p) => p.startsWith(join(root, "a")) })).rejects.toMatchObject({ code: "remote_not_allowed" });
    expect(calls).not.toContain("fetch");
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
    setGitRunner((o) => (o.args[0] === "fetch" && envs.push(o.env), threadRunner(o)));
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
    setGitRunner((o) => (o.args[0] === "fetch" ? new Promise((r) => setTimeout(r, 400)).then(() => threadRunner(o)) : threadRunner(o)));
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
    expect(localRemotePath("file://host/x", "/y/a")).toBe("");
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
  it("the thrown message of a failing fetch has no userinfo", async () => {
    const { a, inside } = remoteRepo();
    run(a, "remote", "remove", "origin");
    run(a, "remote", "add", "bad", "git://bob:pw9x@127.0.0.1:9/x.git");
    const e = await gitFetch(a, { allowed: inside }).then(() => undefined, (x: Error) => x);
    expect(e).toBeDefined();
    expect(e!.message).not.toMatch(/bob|pw9x/);
  });
});
