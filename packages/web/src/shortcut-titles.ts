// Translated shortcut titles. Kept out of shortcuts.ts and leader.ts: docs/site/scripts/gen-shortcuts.ts imports those under plain tsx,
// where i18n.ts (import.meta.glob) cannot load. The English `title` fields there stay the source of the docs page.
import { getLocale, translate, type Key } from "./i18n.ts";
import type { ShortcutGroup } from "./shortcuts.ts";

/** Title of the shortcut `id` (a command id of SHORTCUTS) in `locale`, default the language in use. */
export const shortcutTitle = (id: string, locale = getLocale()) => translate(locale, `shortcut.${id}` as Key);
/** Title of the second key of the prefix key that runs the command `id` (PREFIX_KEYS). */
export const prefixTitle = (id: string, locale = getLocale()) => translate(locale, `shortcut.prefix.${id}` as Key);
export const groupTitle = (group: ShortcutGroup, locale = getLocale()) => translate(locale, `shortcuts.group.${group}` as Key);
