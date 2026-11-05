// Annotate (GH-564): per-line entries of a git blame, pure (the CodeMirror gutter is blame-gutter.ts).
import type { GitBlame } from "@claude-ui/protocol";
import { dateFormat, t } from "./i18n.ts";

/** One line of the gutter. `label`: text shown at the first line of a run of one commit, empty on the others. `hash`: null = not committed. */
export type BlameEntry = { hash: string | null; label: string; title: string; aria: string };

const day = (time: number) => dateFormat({ dateStyle: "medium" }).format(new Date(time * 1000));

/** One entry per line of the blame (at most `lineCount`; the last "line" after a final newline has none); every line of an untracked file is not committed. */
export function blameEntries(b: GitBlame, lineCount: number): BlameEntry[] {
  const out: BlameEntry[] = [];
  const n = b.untracked ? lineCount : Math.min(lineCount, b.lines.length);
  for (let i = 0; i < n; i++) {
    const hash = b.untracked ? null : (b.lines[i] ?? null);
    const first = i === 0 || (b.untracked ? null : (b.lines[i - 1] ?? null)) !== hash;
    const c = hash ? b.commits[hash] : undefined;
    if (!hash || !c) {
      out.push({ hash: null, label: first ? t("files.annotate.notCommitted") : "", title: t("files.annotate.notCommittedAria"), aria: t("files.annotate.notCommittedAria") });
      continue;
    }
    const short = hash.slice(0, 7);
    const date = day(c.time);
    out.push({
      hash,
      label: first ? `${short} ${date} ${c.author}` : "",
      title: `${c.author}, ${date}, ${short}\n${c.summary}\n${t("files.annotate.open")}`,
      aria: t("files.annotate.commit", { hash: short, author: c.author, date }),
    });
  }
  return out;
}
