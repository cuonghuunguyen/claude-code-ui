// GH-646: the user's editor command line, shared so the daemon (which runs it) and the web menu (which names it) read it the same way.

/** An editor command line as argv: words split at spaces, `"..."` groups (also inside a word). No escapes, no expansion. [] for an empty line or an unbalanced quote. */
export function parseEditorCommand(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let open = false;
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') (open = !open), (quoted = true);
    else if (!open && /\s/.test(ch)) {
      if (cur || quoted) out.push(cur);
      cur = "";
      quoted = false;
    } else cur += ch;
  }
  if (open) return [];
  if (cur || quoted) out.push(cur);
  return out;
}

/** The menu label of the custom editor: its name, else the program name without folder and extension; "" when the command has no program. */
export const editorLabel = (e: { command: string; name: string }): string => e.name || (parseEditorCommand(e.command)[0] ?? "").split(/[\\/]/).pop()!.replace(/\.[^.]+$/, "");
