// Saves the prompt text of one PromptBox as a draft (drafts.ts): debounced while typing, at once when emptied (sent) and when the page
// goes to the background (iOS may discard it there without warning). The initial text comes from loadDraft, so nothing is "restored" later.
import { useEffect, useRef } from "react";
import { saveDraft } from "./drafts.ts";

export const DRAFT_DEBOUNCE_MS = 400;

/**
 * `text` is what the box holds; `initial` what it started with (the stored draft). Bash mode text (a half-typed command) is not saved.
 * A new `key` (the box follows its text into the session /clear started) moves the draft: the old key's draft is dropped.
 */
export function useDraft(key: string | undefined, text: string, bash: boolean, initial: string): void {
  const saved = useRef(initial);
  const keyRef = useRef(key);
  const latest = useRef({ text, bash });
  latest.current = { text, bash };
  useEffect(() => {
    if (keyRef.current === key) return;
    if (keyRef.current) saveDraft(keyRef.current, "");
    keyRef.current = key;
    saved.current = "";
  }, [key]);
  const flush = () => {
    const { text, bash } = latest.current;
    const k = keyRef.current;
    if (!k || bash || text === saved.current) return;
    saved.current = text;
    saveDraft(k, text);
  };
  useEffect(() => {
    if (text === "") return flush();
    const t = setTimeout(flush, DRAFT_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [text, bash, key]);
  useEffect(() => {
    const hide = () => document.visibilityState === "hidden" && flush();
    document.addEventListener("visibilitychange", hide);
    addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", hide);
      removeEventListener("pagehide", flush);
      flush();
    };
  }, []);
}
