// File tree context menu (GH-360): the items per target as data, the error texts of the write operations and the name selection of the inline input.
import type { FsEntry } from "@claude-ui/protocol";

export type TreeTarget = { kind: "file"; entry: FsEntry; changed: boolean } | { kind: "dir"; entry: FsEntry; expanded: boolean } | { kind: "root" };
export type TreeCommand = "open" | "viewer" | "changes" | "mention" | "copyPath" | "copyRel" | "rename" | "duplicate" | "delete" | "newFile" | "newFolder" | "collapse" | "refresh";
export type TreeMenuEntry = { id: TreeCommand; label: string; disabled?: boolean; destructive?: boolean; /** Shown right-aligned. */ shortcut?: string; /** `aria-keyshortcuts`. */ keys?: string; testId: string };

const item = (id: TreeCommand, label: string, extra: Partial<TreeMenuEntry> = {}): TreeMenuEntry => ({ id, label, testId: `tree-menu-${id}`, ...extra });

/** Sections of the menu, a separator between sections (VS Code's explorer order). "Open to the side" slots in after Open once the split view (#356) exists. */
export function treeMenuSections(t: TreeTarget, mac: boolean): TreeMenuEntry[][] {
  const rename = item("rename", "Rename…", { shortcut: "F2", keys: "F2" });
  const del = item("delete", "Delete…", { shortcut: mac ? "⌘⌫" : "Del", keys: mac ? "Meta+Backspace Delete" : "Delete", destructive: true });
  const copy = [item("copyPath", "Copy path"), item("copyRel", "Copy relative path")];
  if (t.kind === "file")
    return [
      [item("open", "Open"), item("viewer", "Open in popup viewer"), ...(t.changed ? [item("changes", "Show changes")] : [])],
      [item("mention", "Add to prompt"), ...copy],
      [rename, item("duplicate", "Duplicate"), del],
    ];
  if (t.kind === "dir") return [[item("newFile", "New file…"), item("newFolder", "New folder…")], copy, [rename, del], [item("collapse", "Collapse", { disabled: !t.expanded })]];
  return [[item("newFile", "New file…"), item("newFolder", "New folder…")], [item("refresh", "Refresh")]];
}

/** The inline message of a failed create, rename, delete or duplicate. */
export function opErrorText(code: string, message: string, name: string): string {
  switch (code) {
    case "exists":
      return `A file or folder named “${name}” already exists here.`;
    case "not_found":
      return `“${name}” no longer exists.`;
    case "path_not_allowed":
      return `“${name}” is outside the folders claude-ui may change.`;
    case "root_protected":
      return "A project root folder cannot be deleted or renamed.";
    case "in_use":
      return "A session works in this folder. Close that session first.";
    case "too_large":
      return "The file is too large to duplicate (over 512 MB).";
    case "unknown_type":
      return "This side runs an older claude-ui. Update it to change files here.";
    default:
      return message;
  }
}

/** The part of a name the rename input selects: a file without its last extension (a dotfile all), a folder all (VS Code). */
export function nameSelection(name: string, isDir: boolean): [number, number] {
  const dot = name.lastIndexOf(".");
  return [0, isDir || dot <= 0 ? name.length : dot];
}
