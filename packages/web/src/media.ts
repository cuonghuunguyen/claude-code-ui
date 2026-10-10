// Base64 payloads a snapshot or page left out (GH-274): loaded with session.media when shown, cached per session part.
import { parseOmitted } from "@claude-ui/protocol";
import { createContext, useContext, useEffect, useState } from "react";

/** Loads the data URL of payload `index` of a part (session.media). */
export type MediaLoader = (partId: string, index: number) => Promise<string>;
export const MediaContext = createContext<MediaLoader | undefined>(undefined);

/** The cache holds at most this many characters of data URLs (about as many bytes); the least recently used go first. */
export const MEDIA_CACHE_CHARS = 32 * 1024 * 1024;
type Entry = { p: Promise<string>; chars: number };
/** Loads in flight or done, keyed by part and index. A failed load is removed so the next mount retries. */
const cache = new Map<string, Entry>();

function evict() {
  let total = 0;
  for (const e of cache.values()) total += e.chars;
  // Map order = least recently used first; the newest entry stays even when it alone is over the limit.
  for (const [key, e] of cache) {
    if (total <= MEDIA_CACHE_CHARS || cache.size <= 1) break;
    cache.delete(key);
    total -= e.chars;
  }
}

/** The payload through the cache: loaded once per part and index while it stays cached. */
export function loadMedia(loader: MediaLoader, partId: string, index: number): Promise<string> {
  const key = `${partId}#${index}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit.p;
  }
  const entry: Entry = { p: loader(partId, index), chars: 0 };
  cache.set(key, entry);
  entry.p.then(
    (url) => {
      entry.chars = url.length;
      evict();
    },
    () => cache.get(key) === entry && cache.delete(key),
  );
  return entry.p;
}

/**
 * The prompt's images as data URLs for the prompt box: left-out ones come through the cache. Rejects naming the first image
 * that could not be loaded (the caller does not go on without it).
 */
export async function restoreImages(images: string[], partId: string, loader: MediaLoader | undefined): Promise<string[]> {
  return Promise.all(
    images.map((src, i) => {
      if (!parseOmitted(src)) return src;
      return (loader ? loadMedia(loader, partId, i) : Promise.reject(new Error("no loader"))).catch(() => {
        throw new Error(`Image ${i + 1} could not be loaded, so the prompt cannot be restored. Nothing was rewound.`);
      });
    }),
  );
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
    loadMedia(loader, partId, index).then(
      (url) => live && setLoaded(url),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [partId, index, omitted, loader, attempt]);
  return { src: omitted ? loaded : inline, failed: omitted && failed, retry: () => setAttempt((n) => n + 1) };
}
