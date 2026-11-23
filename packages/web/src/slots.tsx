// Theme slots (docs/spec.md "Addon themes and CSS" > Slots): an addon theme may replace the loader, the done icon, the send icon and the Thinking text.
// The marks are elements with `data-part` (`loader`, `done-icon`) that wrap the built-in icon; while the current theme has the slot and its file exists they show the image instead.
// The image is a same-origin addon file URL (themes.ts `assetUrl` checks it), decorative (`alt=""`, `aria-hidden`): the accessible name of the control around it stays.
import { createContext, useContext, useLayoutEffect, useMemo, type ReactNode } from "react";
import { phrasesFor } from "@claude-ui/protocol";
import { AddonsContext, enabledAddons } from "./addons.ts";
import { useLocale } from "./i18n.ts";
import { useColorTheme } from "./theme.ts";
import { addonThemes, type ThemeSlots } from "./themes.ts";

export const SlotsContext = createContext<ThemeSlots | undefined>(undefined);

const IMAGE_SLOTS = ["loader", "done-icon", "send-icon"] as const;

/** The slots of the current theme, shared by context, and `data-slot-<name>` on <html> for every slot that is in effect (CSS can adapt: hide a ring the image replaces). */
export function SlotsProvider({ children }: { children: ReactNode }) {
  const addons = useContext(AddonsContext).addons;
  const id = useColorTheme();
  const { locale } = useLocale();
  const slots = useMemo(() => (id.startsWith("addon:") ? addonThemes(enabledAddons(addons)).find((t) => t.id === id)?.slots : undefined), [addons, id]);
  const phrases = !!phrasesFor(slots?.phrases, locale);
  useLayoutEffect(() => {
    const on = [...IMAGE_SLOTS.filter((k) => slots?.[k]), ...(phrases ? (["thinking-phrases"] as const) : [])].map((k) => `data-slot-${k}`);
    for (const a of on) document.documentElement.setAttribute(a, "");
    return () => on.forEach((a) => document.documentElement.removeAttribute(a));
  }, [slots, phrases]);
  return <SlotsContext value={slots}>{children}</SlotsContext>;
}

export function SlotImage({ url, className }: { url: string; className: string }) {
  return <img src={url} alt="" aria-hidden="true" draggable={false} className={`object-contain ${className}`} />;
}

/** The loading mark (`data-part="loader"`): the theme's `loader` image, else `children` (the built-in spinner). `size`: classes of the image box. */
export function LoaderMark({ children, size = "size-4" }: { children: ReactNode; size?: string }) {
  const url = useContext(SlotsContext)?.loader;
  return (
    <span data-part="loader" className="inline-flex shrink-0">
      {url ? <SlotImage url={url} className={size} /> : children}
    </span>
  );
}

/** The done mark of a finished tool call (`data-part="done-icon"`): the theme's `done-icon` image, else `children` (the built-in check). */
export function DoneMark({ children, size = "size-4" }: { children: ReactNode; size?: string }) {
  const url = useContext(SlotsContext)?.["done-icon"];
  return (
    <span data-part="done-icon" className="inline-flex shrink-0">
      {url ? <SlotImage url={url} className={size} /> : children}
    </span>
  );
}

/** The theme's `send-icon` URL while it is in effect. */
export const useSendIcon = () => useContext(SlotsContext)?.["send-icon"];

const hash = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);

/** The phrase the Thinking row shows instead of the built-in label, or undefined (no phrases for the UI language: the built-in label stays). One phrase per turn, picked from the turn id (the prompt that started it): stable across re-renders, no timer, nothing that moves. */
export function useThinkingPhrase(turn: string | undefined): string | undefined {
  const phrases = phrasesFor(useContext(SlotsContext)?.phrases, useLocale().locale);
  return phrases?.[turn === undefined ? 0 : hash(turn) % phrases.length];
}
