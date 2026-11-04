import { describe, expect, it } from "vitest";
import { SSH_ALIASES, sshConfigText } from "../support/ssh-host.ts";

describe("sshConfigText", () => {
  const text = sshConfigText({ dir: "/run/ssh", port: 2222, closedPort: 2223 });
  it("has one Host block per alias, all inside the run folder", () => {
    for (const a of Object.values(SSH_ALIASES)) expect(text).toContain(`Host ${a}\n`);
    expect(text.match(/IdentityFile (\S+)/g)!.every((l) => l.includes("/run/ssh/"))).toBe(true);
    expect(text.match(/UserKnownHostsFile (\S+)/g)!.every((l) => l.includes("/run/ssh/"))).toBe(true);
  });
  it("host key host trusts nothing, auth host has the wrong key, down host has the closed port", () => {
    const block = (a: string) => text.split("\n\n").find((b) => b.startsWith(`Host ${a}\n`))!;
    expect(block(SSH_ALIASES.hostKey)).toContain("known_hosts_empty");
    expect(block(SSH_ALIASES.auth)).toContain("id_bad");
    expect(block(SSH_ALIASES.down)).toContain("Port 2223");
    expect(block(SSH_ALIASES.ok)).toContain("Port 2222");
  });
});
