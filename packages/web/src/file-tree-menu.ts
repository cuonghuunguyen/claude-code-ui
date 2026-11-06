// File tree context menu (GH-360): the items per target as data, the error texts of the write operations and the name selection of the inline input.
import type { FsEntry, GitRepo } from "@claude-ui/protocol";
import { t as tr } from "./i18n.ts";

export type TreeTarget = { kind: "file"; entry: FsEntry; changed: boolean } | { kind: "dir"; entry: FsEntry; expanded: boolean; /** A listed, readable repository whose folder this is. */ repo?: GitRepo } | { kind: "root" };
export type TreeCommand = "open" | "openTab" | "viewer" | "changes" | "repoChanges" | "repoGraph" | "mention" | "copyPath" | "copyRel" | "cut" | "copy" | "paste" | "rename" | "duplicate" | "delete" | "newFile" | "newFolder" | "collapse" | "refresh";
export type TreeMenuEntry = { id: TreeCommand; label: string; disabled?: boolean; destructive?: boolean; /** Shown right-aligned. */ shortcut?: string; /** `aria-keyshortcuts`. */ keys?: string; testId: string };

const item = (id: TreeCommand, label: string, extra: Partial<TreeMenuEntry> = {}): TreeMenuEntry => ({ id, label, testId: `tree-menu-${id}`, ...extra });

/** Sections of the menu, a separator between sections (VS Code's explorer order). "Open to the side" slots in after Open once the split view (#356) exists. */
export function treeMenuSections(t: TreeTarget, mac: boolean, viewer = true, graph = false, tab = true, canPaste = false): TreeMenuEntry[][] {
  const mod = mac ? "⌘" : "Ctrl+";
  const key = (k: string) => (mac ? `Meta+${k}` : `Control+${k}`);
  const cut = item("cut", tr("files.menu.cut"), { shortcut: `${mod}X`, keys: key("X") });
  const copyIt = item("copy", tr("files.menu.copy"), { shortcut: `${mod}C`, keys: key("C") });
  const paste = item("paste", tr("files.menu.paste"), { shortcut: `${mod}V`, keys: key("V"), disabled: !canPaste });
  const rename = item("rename", tr("files.menu.rename"), { shortcut: "F2", keys: "F2" });
  const del = item("delete", tr("files.menu.delete"), { shortcut: mac ? "⌘⌫" : "Del", keys: mac ? "Meta+Backspace Delete" : "Delete", destructive: true });
  const copy = [item("copyPath", tr("files.menu.copyPath")), item("copyRel", tr("files.menu.copyRel"))];
  if (t.kind === "file")
    return [
      [item("open", tr("files.menu.open")), ...(tab ? [item("openTab", tr("files.openInTab"))] : []), ...(viewer ? [item("viewer", tr("files.openInDialog"))] : []), ...(t.changed ? [item("changes", tr("files.menu.showChanges"))] : [])],
      [cut, copyIt],
      [item("mention", tr("files.menu.mention")), ...copy],
      [rename, item("duplicate", tr("files.menu.duplicate")), del],
    ];
  if (t.kind === "dir") {
    const sections = [[item("newFile", tr("files.menu.newFile")), item("newFolder", tr("files.menu.newFolder"))], [cut, copyIt, paste], copy, [rename, del], [item("collapse", tr("files.menu.collapse"), { disabled: !t.expanded })]];
    return t.repo ? [[item("repoChanges", tr("files.menu.showChanges")), ...(graph ? [item("repoGraph", tr("files.menu.showGraph"))] : [])], ...sections] : sections;
  }
  return [[item("newFile", tr("files.menu.newFile")), item("newFolder", tr("files.menu.newFolder"))], [paste], [item("refresh", tr("files.menu.refresh"))]];
}

/** The inline message of a failed create, rename, delete or duplicate. */
export function opErrorText(code: string, message: string, name: string): string {
  switch (code) {
    case "exists":
      return tr("files.opError.exists", { name });
    case "not_found":
      return tr("files.opError.notFound", { name });
    case "path_not_allowed":
      return tr("files.opError.notAllowed", { name });
    case "root_protected":
      return tr("files.opError.rootProtected");
    case "in_use":
      return tr("files.opError.inUse");
    case "too_large":
      return tr("files.opError.tooLarge");
    case "too_many":
      return tr("files.opError.tooMany");
    case "into_itself":
      return tr("files.opError.intoItself");
    case "conflict":
      return tr("files.opError.conflict");
    case "unknown_type":
      return tr("files.opError.unknownType");
    default:
      return message;
  }
}

/** The part of a name the rename input selects: a file without its last extension (a dotfile all), a folder all (VS Code). */
export function nameSelection(name: string, isDir: boolean): [number, number] {
  const dot = name.lastIndexOf(".");
  return [0, isDir || dot <= 0 ? name.length : dot];
}
