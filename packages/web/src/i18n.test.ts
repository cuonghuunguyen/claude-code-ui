// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { browserLocale, getLocale, LOCALES, setLocalePref, translate, type Key } from "./i18n.ts";

const en = LOCALES.en.messages;
const placeholders = (m: unknown) => [...new Set(JSON.stringify(m).match(/\{\w+\}/g) ?? [])].sort();

describe("catalogs", () => {
  it("ship English and Vietnamese", () => expect(Object.keys(LOCALES).sort()).toEqual(["en", "vi"]));

  for (const [code, cat] of Object.entries(LOCALES).filter(([c]) => c !== "en")) {
    it(`${code} has every English key and no other`, () => {
      expect(Object.keys(cat.messages).filter((k) => !(k in en))).toEqual([]);
      expect(Object.keys(en).filter((k) => !(k in cat.messages))).toEqual([]);
    });
    it(`${code} keeps every placeholder of the English text`, () => {
      const wrong = (Object.keys(en) as Key[]).filter((k) => k in cat.messages && placeholders(cat.messages[k]).join() !== placeholders(en[k]).join());
      expect(wrong).toEqual([]);
    });
    it(`${code} plurals have an "other" form`, () => {
      const bad = Object.entries(cat.messages).filter(([, m]) => typeof m === "object" && !m.other);
      expect(bad).toEqual([]);
    });
  }
});

describe("translate", () => {
  it("falls back to English for a key the locale lacks, never the raw key", () => {
    LOCALES.zz = { name: "Test", messages: {} };
    expect(translate("zz", "language.label")).toBe(en["language.label"]);
    expect(translate("nope", "language.label")).toBe(en["language.label"]);
    delete LOCALES.zz;
  });

  it("picks the plural form by count and fills placeholders", () => {
    LOCALES.ru = { name: "Test", messages: { ["language.label" as Key]: { one: "{count} файл", few: "{count} файла", many: "{count} файлов", other: "{count} файла" } } };
    LOCALES.ko = { name: "Test", messages: { ["language.label" as Key]: { other: "{count} tệp ở {path}" } } };
    expect(translate("ru", "language.label", { count: 1 })).toBe("1 файл");
    expect(translate("ru", "language.label", { count: 3 })).toBe("3 файла");
    expect(translate("ru", "language.label", { count: 5 })).toBe("5 файлов");
    expect(translate("ko", "language.label", { count: 1, path: "src" })).toBe("1 tệp ở src");
    delete LOCALES.ru;
    delete LOCALES.ko;
  });

  it("leaves an unknown placeholder as written", () => {
    LOCALES.zz = { name: "Test", messages: { ["language.label" as Key]: "{a} {b}" } };
    expect(translate("zz", "language.label", { a: 1 })).toBe("1 {b}");
    delete LOCALES.zz;
  });
});

describe("language choice", () => {
  it("follows the browser by primary subtag, else English", () => {
    expect(browserLocale(["vi-VN", "en"])).toBe("vi");
    expect(browserLocale(["fr-FR", "de"])).toBe("en");
    expect(browserLocale(["fr-FR", "vi"])).toBe("vi");
  });

  it("a pick applies at once, sets <html lang> and is kept", () => {
    setLocalePref("vi");
    expect(getLocale()).toBe("vi");
    expect(document.documentElement.lang).toBe("vi");
    expect(localStorage.getItem("claude-ui.locale")).toBe("vi");
    setLocalePref("system");
    expect(getLocale()).toBe("en");
    expect(document.documentElement.lang).toBe("en");
  });
});
