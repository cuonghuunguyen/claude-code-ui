import { afterEach, expect, it } from "vitest";
import en from "./i18n/en/index.ts";
import { setLocalePref } from "./i18n.ts";
import { PREFIX_KEYS } from "./leader.ts";
import { SHORTCUTS } from "./shortcuts.ts";
import { groupTitle, prefixTitle, shortcutTitle } from "./shortcut-titles.ts";

afterEach(() => setLocalePref("system"));

it("every shortcut and prefix key has a catalog title equal to its English `title` (the docs page source)", () => {
  for (const s of SHORTCUTS) expect(shortcutTitle(s.id, "en"), s.id).toBe(s.title);
  for (const p of PREFIX_KEYS) expect(prefixTitle(p.id, "en"), p.id).toBe(p.title);
  for (const g of new Set(SHORTCUTS.map((s) => s.group))) expect(en.messages[`shortcuts.group.${g}`]).toBeTruthy();
});

it("a title is translated by locale, defaulting to the language in use", () => {
  expect(shortcutTitle("palette.open", "vi")).toBe("Bảng lệnh");
  setLocalePref("vi");
  expect(shortcutTitle("session.new")).toBe("Phiên mới");
  expect(groupTitle("Tabs")).toBe("Tab");
});
