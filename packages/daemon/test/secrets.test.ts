import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createSecrets } from "../src/secrets.ts";

it("a corrupt secrets.json logs no file content (GH-451)", () => {
  for (const content of ["tok-SECRET-1", '{"jiraToken":"tok-SECRET-1"']) {
    const file = join(mkdtempSync(join(tmpdir(), "secrets-")), "secrets.json");
    writeFileSync(file, content);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(createSecrets({ file }).jiraToken()).toBeUndefined();
      expect(log).toHaveBeenCalledTimes(1);
      const text = log.mock.calls.flat().map(String).join(" ");
      expect(text).toContain("secrets");
      expect(text).toContain("not valid JSON");
      expect(text).not.toContain("tok-SECRET-1");
    } finally {
      log.mockRestore();
    }
  }
});
