// GH-716: a WSL side uses the distro's OpenCode, never the Windows one found on the appended Windows PATH.
import { describe, expect, it } from "vitest";
import { createOpenCodeServer, lookup } from "../src/opencode-server.ts";

const files = (...list: string[]) => (f: string) => list.includes(f);
const WIN_SHIM = "/mnt/c/Program Files/nodejs/opencode";
const PATH = "/usr/local/bin:/usr/bin:/mnt/c/WINDOWS:/mnt/c/Program Files/nodejs:/snap/bin";
const linux = { platform: "linux" as const, home: "/home/alice" };

describe("OpenCode lookup (GH-716)", () => {
  it.each<[string, boolean, string[], object]>([
    ["in WSL a binary on a Windows drive is skipped; a later Linux one on PATH is used", true, [WIN_SHIM, "/snap/bin/opencode"], { cmd: ["/snap/bin/opencode"] }],
    ["in WSL the installer's ~/.opencode/bin is used when PATH holds only the Windows one", true, [WIN_SHIM, "/home/alice/.opencode/bin/opencode"], { cmd: ["/home/alice/.opencode/bin/opencode"] }],
    ["in WSL with only the Windows one: no command, the Windows file is named", true, [WIN_SHIM], { windows: WIN_SHIM }],
    ["outside WSL /mnt is an ordinary folder", false, [WIN_SHIM, "/home/alice/.opencode/bin/opencode"], { cmd: [WIN_SHIM] }],
    ["outside WSL PATH wins over ~/.opencode/bin", false, ["/usr/bin/opencode", "/home/alice/.opencode/bin/opencode"], { cmd: ["/usr/bin/opencode"] }],
    ["nothing anywhere: neither a command nor a Windows file", true, [], {}],
  ])("lookup finds the OpenCode binary: %s", (_name, wsl, present, expected) => {
    expect(lookup({ PATH }, { ...linux, wsl, exists: files(...present) })).toEqual(expected);
  });

  it("status names the Windows OpenCode and the fix when only that one is found", async () => {
    const server = createOpenCodeServer({ path: () => "", env: () => ({ PATH }), lookup: { ...linux, wsl: true, exists: files(WIN_SHIM) } });
    const s = await server.status();
    expect(s.state).toBe("missing");
    expect(s.message).toContain(WIN_SHIM);
    expect(s.message).toMatch(/Install OpenCode inside the distro.*Settings › OpenCode/);
  });
});
