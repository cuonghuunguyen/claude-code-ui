// Base64 payloads a snapshot or page left out (GH-274): loaded with session.media when shown, cached per session part.
import { createContext, useContext, useEffect, useState } from "react";

/** Loads the data URL of payload `index` of a part (session.media). */
export type MediaLoader = (partId: string, index: number) => Promise<string>;
export const MediaContext = createContext<MediaLoader | undefined>(undefined);

const CACHE_MAX = 64;
/** Loads in flight or done, keyed by part and index; the oldest goes first. A failed load is removed so the next mount retries. */
const cache = new Map<string, Promise<string>>();

function load(loader: MediaLoader, partId: string, index: number): Promise<string> {
  const key = `${partId}#${index}`;
  let p = cache.get(key);
  if (!p) {
    p = loader(partId, index);
    cache.set(key, p);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
    p.catch(() => cache.get(key) === p && cache.delete(key));
  }
  return p;
}

export type MediaState = { src?: string; failed: boolean; retry: () => void };

/**
 * `src`: `inline` as is when the payload is inline; for an omitted one the loaded data URL (undefined while loading, on error or without a loader).
 * `failed`: the load was rejected; `retry` requests it again.
 */
export function useMediaSrc(partId: string, index: number, omitted: boolean, inline?: string): MediaState {
  const loader = useContext(MediaContext);
  const [loaded, setLoaded] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!omitted || !loader) return;
    let live = true;
    setFailed(false);
    load(loader, partId, index).then(
      (url) => live && setLoaded(url),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [partId, index, omitted, loader, attempt]);
  return { src: omitted ? loaded : inline, failed: omitted && failed, retry: () => setAttempt((n) => n + 1) };
}
