import { expect, it } from "vitest";
import { fileIconName } from "./file-icon.tsx";

it("picks OpenCode's icon by file name, then the longest extension, else Document", () => {
  expect(fileIconName("README.md")).toBe("Readme");
  expect(fileIconName("src/client/app.tsx")).toBe("React_ts");
  expect(fileIconName("src/server/search.ts")).toBe("Typescript");
  expect(fileIconName("src/types.d.ts")).not.toBe("Typescript");
  expect(fileIconName("docs/spec.md")).toBe("Markdown");
  expect(fileIconName("bin/unknown")).toBe("Document");
});
