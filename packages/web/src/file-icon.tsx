// File-type icons as OpenCode's FileIcon (packages/ui/src/components/file-icon.tsx): its file name and extension maps and
// sprite symbols (material icon theme), cut to the icons those maps use. file-icons.json and public/file-icons.svg are generated from it.
import maps from "./file-icons.json";

const names: Record<string, string> = maps.names;
const extensions: Record<string, string> = maps.extensions;

/** By whole file name, then the longest dotted suffix ("d.ts" before "ts"), else OpenCode's default. */
export function fileIconName(path: string) {
  const base = path.split("/").pop()!.toLowerCase();
  if (names[base]) return names[base];
  const suffixes = [base, ...[...base.matchAll(/\./g)].map((m) => base.slice(m.index + 1))].filter(Boolean);
  for (const s of suffixes.sort((a, b) => b.length - a.length)) if (extensions[s]) return extensions[s];
  return "Document";
}

export function FileIcon({ path, className }: { path: string; className?: string }) {
  return (
    <svg className={className} aria-hidden data-icon={fileIconName(path)}>
      <use href={`/file-icons.svg#${fileIconName(path)}`} />
    </svg>
  );
}
