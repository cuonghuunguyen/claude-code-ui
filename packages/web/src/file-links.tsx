// File references in markdown (docs/spec.md "Session view UX", "Editor"): inline code like `src/a.ts:12` and relative links open the Files tab.
import { createContext, createElement, use, useEffect, useState, type ComponentProps } from "react";
import { defaultComponents, defaultRemarkPlugins, type Components } from "streamdown";
import { inDir, isWinPath, joinPath, sepOf, withSep } from "./paths.ts";
import { CwdContext } from "./tool-card.tsx";

/** Opens `path` in the Files tab, at `line` when given. Without a provider, file references stay plain text. */
export const FileLinkContext = createContext<((path: string, line?: number) => void) | undefined>(undefined);
/** Where relative references resolve (`base`) and what they must stay inside (`root`); the session cwd when absent. */
export const FileBaseContext = createContext<{ base: string; root: string } | undefined>(undefined);

/** Gives the URL of an image file (an `fs.media` answer): the markdown preview provides it; without one a relative image shows its alt text. */
export const FileImageContext = createContext<((path: string) => Promise<string>) | undefined>(undefined);

/** A relative (or absolute) target as a path inside `root`, "." and ".." resolved; undefined when it leaves `root`. */
export function resolveIn(target: string, base: string, root: string): string | undefined {
  let t = target.split(/[?#]/)[0]!;
  try {
    t = decodeURIComponent(t);
  } catch {
    // keep the raw text
  }
  if (!t) return;
  // A leading "/" outside the root is relative to the root, as on GitHub (`/docs/logo.png`).
  const rootAbs = t.startsWith("/") && !isWinPath(root) && !inDir(t, root);
  const full = rootAbs ? withSep(root) + t.slice(1) : t.startsWith("/") || isWinPath(t) ? t : withSep(base) + t;
  const parts = full.split(/[\\/]/);
  const out: string[] = [parts[0]!];
  for (const p of parts.slice(1)) {
    if (p === "..") {
      if (out.length > 1) out.pop();
    } else if (p && p !== ".") out.push(p);
  }
  const path = out.join(sepOf(root));
  return inDir(path, root) && path.length > root.replace(/[\\/]$/, "").length ? path : undefined;
}

const percentDecoded = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** An explicit link target (not a guess from prose): `resolveIn`'s path, the line of a `#LN` suffix. */
export function linkRef(target: string, base: string, root: string): { path: string; line?: number } | undefined {
  const path = resolveIn(target, base, root);
  const m = /#L(\d+)(?:-L?\d+)?$/.exec(target);
  return path ? { path, ...(m && Number(m[1]) > 0 && { line: Number(m[1]) }) } : undefined;
}

/** Extensions that make a bare word a file ("process.env", "JSON.parse" and "e.g" stay text); a name with a path separator needs none of these. */
export const SOURCE_EXT = new Set(
  "ts tsx js jsx mjs cjs json jsonc md mdx py rs go java kt kts c h cc cpp hpp cs rb php sh bash zsh yml yaml toml ini css scss less html vue svelte sql txt xml gradle swift lock".split(" "),
);

/**
 * `text` as a file inside `root`: `path` (absolute, `base` for a relative one) and the line of a `:N`, `:N:M`, `:N-M`, `#LN` or `#LN-M` suffix.
 * Undefined for anything else: prose, URLs, option flags, `..` paths, paths outside `root`.
 */
export function fileRef(text: string, base: string, root = base): { path: string; line?: number } | undefined {
  let s = text.trim();
  if (!s || /[\s*?<>|"]/.test(s) || s.includes("://") || /^[-@~]/.test(s)) return;
  let line: number | undefined;
  const suffix = /(?::(\d+)(?::\d+|-\d+)?|#L(\d+)(?:-L?\d+)?)$/.exec(s);
  if (suffix) {
    line = Number(suffix[1] ?? suffix[2]) || undefined;
    s = s.slice(0, suffix.index);
  }
  const parts = s.split(/[\\/]/);
  if (parts.includes("..")) return;
  const ext = /\.([A-Za-z0-9]{1,10})$/.exec(parts.at(-1)!)?.[1];
  if (!ext || !/[A-Za-z]/.test(ext)) return;
  if (parts.length === 1 && !SOURCE_EXT.has(ext.toLowerCase())) return;
  const path = s.startsWith("/") || isWinPath(s) ? s : joinPath(base, s.replace(/^\.\//, ""));
  if (!inDir(path, root) || path.length <= root.replace(/[\\/]$/, "").length) return;
  return { path, ...(line && { line }) };
}

const FILE_LINK = "streamdown:file/";

/**
 * Streamdown's sanitizer drops a relative link without "./" and flattens "./x" to "/x"; "streamdown:" is a protocol it lets through.
 * So a relative link's target travels as `streamdown:file/<encoded target>` and `FileAnchor` decodes it.
 */
function fileLinks() {
  const walk = (node: { type?: string; url?: unknown; children?: unknown[] }) => {
    if ((node.type === "link" || node.type === "image") && typeof node.url === "string" && node.url && !node.url.startsWith("#") && !node.url.startsWith("//") && !/^[a-z][a-z\d+.-]+:/i.test(node.url))
      node.url = FILE_LINK + encodeURIComponent(node.url);
    for (const c of node.children ?? []) walk(c as typeof node);
  };
  return walk;
}

function LoadedImage({ path, alt }: { path: string; alt?: string }) {
  const load = use(FileImageContext);
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    load?.(path).then((u) => live && setUrl(u), () => live && setFailed(true));
    return () => void (live = false);
  }, [path, load]);
  if (!url || failed) return <span className="text-muted-foreground">{alt || (failed ? "Image not available" : "")}</span>;
  return <img src={url} alt={alt} loading="lazy" className="h-auto max-w-full rounded" onError={() => setFailed(true)} />;
}

function FileImage(props: ComponentProps<"img">) {
  const { base, root } = useTarget();
  const src = typeof props.src === "string" ? props.src : undefined;
  if (!src?.startsWith(FILE_LINK)) return createElement(defaultComponents.img as never, props as never);
  const path = base ? resolveIn(decodeURIComponent(src.slice(FILE_LINK.length)), base, root) : undefined;
  return path ? <LoadedImage path={path} alt={props.alt} /> : <span className="text-muted-foreground">{props.alt}</span>;
}

const REMARK = [...Object.values(defaultRemarkPlugins), fileLinks];

function useTarget() {
  const open = use(FileLinkContext);
  const cwd = use(CwdContext);
  const b = use(FileBaseContext);
  return { open, base: b?.base ?? cwd, root: b?.root ?? cwd };
}

const refClass = "cursor-pointer text-left underline decoration-dotted underline-offset-2 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring";

function FileCode(props: ComponentProps<"code">) {
  const { open, base, root } = useTarget();
  const text = typeof props.children === "string" ? props.children : undefined;
  const ref = open && base && text ? fileRef(text, base, root) : undefined;
  if (!ref) return createElement(defaultComponents.code as never, props as never);
  return (
    <button type="button" className={`rounded bg-muted px-1.5 py-0.5 font-mono text-sm ${refClass}`} title="Open in file dialog" onClick={() => open!(ref.path, ref.line)}>
      {text}
    </button>
  );
}

function FileAnchor(props: ComponentProps<"a">) {
  const { open, base, root } = useTarget();
  const href = props.href;
  if (!href?.startsWith(FILE_LINK)) return createElement(defaultComponents.a as never, props as never);
  const target = decodeURIComponent(href.slice(FILE_LINK.length));
  const ref = open && base ? (fileRef(percentDecoded(target), base, root) ?? linkRef(target, base, root)) : undefined;
  if (!ref) return <span>{props.children}</span>;
  return (
    <button type="button" className={`text-primary ${refClass}`} title="Open in file dialog" onClick={() => open!(ref.path, ref.line)}>
      {props.children}
    </button>
  );
}

/** Stable constants: MessageResponse re-renders on a new `children` only, and Streamdown compares these by identity. */
export const FILE_LINK_PROPS: { components: Components; remarkPlugins: typeof REMARK } = { components: { inlineCode: FileCode, a: FileAnchor, img: FileImage } as Components, remarkPlugins: REMARK };
