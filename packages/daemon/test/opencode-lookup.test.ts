// GH-716: a WSL side uses the distro's OpenCode, never the Windows one found on the appended Windows PATH.
import { describe, expect, it } from "vitest";
import { createOpenCodeServer, lookup } from "../src/opencode-server.ts";

const files = (...list: string[]) => (f: string) => list.includes(f);
const WIN_SHIM = "/mnt/c/Program Files/nodejs/opencode";
const PATH = "/usr/local/bin:/usr/bin:/mnt/c/WINDOWS:/mnt/c/Program Files/nodejs:/snap/bin";
const linux = { platform: "linux" as const, home: "/home/alice" };

describe("OpenCode lookup (GH-716)", () => {
  it("in WSL a binary on a Windows drive is skipped; a later Linux one on PATH is used", () => {
    expect(lookup({ PATH }, { ...linux, wsl: true, exists: files(WIN_SHIM, "/snap/bin/opencode") })).toEqual({ cmd: ["/snap/bin/opencode"] });
  });

  it("in WSL the installer's ~/.opencode/bin is used when PATH holds only the Windows one", () => {
    expect(lookup({ PATH }, { ...linux, wsl: true, exists: files(WIN_SHIM, "/home/alice/.opencode/bin/opencode") })).toEqual({ cmd: ["/home/alice/.opencode/bin/opencode"] });
  });

  it("in WSL with only the Windows one: no command, the Windows file is named", () => {
    expect(lookup({ PATH }, { ...linux, wsl: true, exists: files(WIN_SHIM) })).toEqual({ windows: WIN_SHIM });
  });

  it("outside WSL /mnt is an ordinary folder; PATH wins over ~/.opencode/bin", () => {
    expect(lookup({ PATH }, { ...linux, wsl: false, exists: files(WIN_SHIM, "/home/alice/.opencode/bin/opencode") })).toEqual({ cmd: [WIN_SHIM] });
    expect(lookup({ PATH }, { ...linux, wsl: false, exists: files("/usr/bin/opencode", "/home/alice/.opencode/bin/opencode") })).toEqual({ cmd: ["/usr/bin/opencode"] });
  });

  it("nothing anywhere: neither a command nor a Windows file", () => {
    expect(lookup({ PATH }, { ...linux, wsl: true, exists: files() })).toEqual({});
  });

  it("status names the Windows OpenCode and the fix when only that one is found", async () => {
    const server = createOpenCodeServer({ path: () => "", env: () => ({ PATH }), lookup: { ...linux, wsl: true, exists: files(WIN_SHIM) } });
    const s = await server.status();
    expect(s.state).toBe("missing");
    expect(s.message).toContain(WIN_SHIM);
    expect(s.message).toMatch(/Install OpenCode inside the distro.*Settings › OpenCode/);
  });
});
