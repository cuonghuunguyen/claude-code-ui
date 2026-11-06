import { existsSync } from "node:fs";
import { createRequire } from "node:module";

/** The SDK's bundled platform CLI (same lookup as the SDK: `@anthropic-ai/claude-agent-sdk-<os>-<arch>/claude[.exe]`, glibc before musl on Linux). */
export function claudeBin(platform = process.platform, arch = process.arch, exists = existsSync, req = createRequire(import.meta.url)): string {
  const base = "@anthropic-ai/claude-agent-sdk";
  const pkgs = platform === "linux" ? [`${base}-linux-${arch}`, `${base}-linux-${arch}-musl`] : [`${base}-${platform}-${arch}`];
  for (const p of pkgs)
    try {
      const file = req.resolve(`${p}/claude${platform === "win32" ? ".exe" : ""}`);
      if (exists(file)) return file;
    } catch {}
  throw new Error(`the Claude CLI of the Agent SDK is not installed for ${platform}-${arch}`);
}
