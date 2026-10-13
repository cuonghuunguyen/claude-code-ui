import { describe, expect, it } from "vitest";
import { wslHostPath, wslPathOf } from "../src/wsl-path.ts";

describe("wsl-path", () => {
  it("wslPathOf recognizes wsl$ and wsl.localhost paths in any case and slash", () => {
    expect(wslPathOf("\\\\wsl.localhost\\Ubuntu\\home\\me\\")).toEqual({ distro: "Ubuntu", posix: "/home/me", root: "\\\\wsl.localhost\\Ubuntu" });
    expect(wslPathOf("//WSL$/Debian")).toEqual({ distro: "Debian", posix: "/", root: "\\\\WSL$\\Debian" });
    expect(wslPathOf("C:\\x")).toBeUndefined();
    expect(wslPathOf("\\\\server\\share\\x")).toBeUndefined();
    expect(wslPathOf("/home/me")).toBeUndefined();
  });
  it("wslHostPath maps POSIX back under the root, /mnt drives to Windows drives", () => {
    expect(wslHostPath("\\\\wsl$\\U", "/home/me/wt")).toBe("\\\\wsl$\\U\\home\\me\\wt");
    expect(wslHostPath("\\\\wsl$\\U", "/mnt/c/src")).toBe("C:\\src");
    expect(wslHostPath("\\\\wsl$\\U", "/")).toBe("\\\\wsl$\\U\\");
  });
});
