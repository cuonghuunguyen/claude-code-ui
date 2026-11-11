// A Windows `opencode.cmd` in a folder with spaces (npm's global bin under C:\Program Files) runs through cmd.exe quoted as one line.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createOpenCodeServer, invocation } from "../src/opencode-server.ts";

const BIN = fileURLToPath(new URL("./fixtures/opencode/fake-opencode-bin.mjs", import.meta.url));

describe("OpenCode .cmd launcher", () => {
  it("invocation: a .cmd on Windows is one quoted cmd.exe line passed verbatim; anything else runs directly", () => {
    expect(invocation("C:\\Program Files\\nodejs\\opencode.cmd", ["--version"], "win32")).toEqual({
      file: "cmd.exe",
      args: ["/d", "/s", "/c", '""C:\\Program Files\\nodejs\\opencode.cmd" "--version""'],
      verbatim: true,
    });
    expect(invocation("C:\\bin\\opencode.exe", ["--version"], "win32")).toEqual({ file: "C:\\bin\\opencode.exe", args: ["--version"], verbatim: false });
    expect(invocation("/usr/bin/opencode.cmd", ["serve"], "linux")).toEqual({ file: "/usr/bin/opencode.cmd", args: ["serve"], verbatim: false });
  });

  it.runIf(process.platform === "win32")("a .cmd in a folder with spaces and parentheses answers --version and serves", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "oc-")), "Program Files (x86)", "node js");
    mkdirSync(dir, { recursive: true });
    const cmd = join(dir, "opencode.cmd");
    writeFileSync(cmd, `@"${process.execPath}" "${BIN}" %*\r\n`);
    const server = createOpenCodeServer({ path: () => cmd, env: () => ({ FAKE_OPENCODE_LOG: join(dir, "log.jsonl") }) });
    try {
      const up = await server.ensure();
      expect(up.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);
    } finally {
      await server.stop();
    }
  }, 30_000);
});
