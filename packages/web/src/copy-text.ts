import { t } from "./i18n.ts";

/** Toast of a failed copy: the browser allows the clipboard only on HTTPS or localhost; the text is shown to copy by hand. */
export function copyFailText(text?: string): string {
  const why = t("app.copy.failed");
  return text ? t("app.copy.byHand", { why, text }) : why;
}
