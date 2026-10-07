// Tool knowledge for tool cards (docs/spec.md "Session view UX").
import { parseDiffFromFile } from "@pierre/diffs";
import { isWinPath, relPath } from "./paths.ts";

/** Read/search tools; consecutive calls merge into one context group. */
export const CONTEXT_TOOLS = new Set(["Read", "Grep", "Glob"]);

// Input fields that best describe a call, most telling first.
const SUMMARY_KEYS = ["file_path", "notebook_path", "pattern", "command", "path", "url", "query", "description", "prompt"];

/** One-line summary of a tool input for the card header. */
export function toolSummary(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const fields = input as Record<string, unknown>;
  const key = SUMMARY_KEYS.find((k) => typeof fields[k] === "string");
  const value = key ? fields[key] : Object.values(fields).find((v) => typeof v === "string");
  return typeof value === "string" ? (value.split("\n")[0] ?? "") : "";
}

/** File name and directory for a card header; the directory relative to `cwd` when the file is inside it. */
export function filePath(path: string, cwd: string) {
  const rel = relPath(path, cwd);
  const i = isWinPath(path) ? Math.max(rel.lastIndexOf("/"), rel.lastIndexOf("\\")) : rel.lastIndexOf("/");
  return { name: rel.slice(i + 1), dir: i < 0 ? "" : rel.slice(0, i) || "/" };
}

/** Line range of a Read call, from the numbered result lines if any, else from offset/limit. */
export function readRange(input: unknown, output?: unknown): string {
  const nums = typeof output === "string" ? [...output.matchAll(/^\s*(\d+)[\t→]/gm)].map((m) => Number(m[1])) : [];
  if (nums.length > 0) return `lines ${nums[0]}–${nums.at(-1)}`;
  const { offset, limit } = (input ?? {}) as { offset?: unknown; limit?: unknown };
  const start = typeof offset === "number" ? offset : 1;
  if (typeof limit === "number") return `lines ${start}–${start + limit - 1}`;
  return typeof offset === "number" ? `from line ${start}` : "";
}

type FileContents = { name: string; contents: string };

/** Old and new file for an Edit/Write diff, built from the tool input alone; undefined until the input is complete. */
export function editFiles(tool: string, input: unknown): { oldFile: FileContents; newFile: FileContents } | undefined {
  const i = (input ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const name = str(i.file_path);
  // Edit strings are fragments, not whole files: end them with a newline, else the diff marks "No newline at end of file".
  const line = (v: unknown) => (typeof v === "string" && v && !v.endsWith("\n") ? `${v}\n` : str(v));
  const [before, after] = tool === "Edit" ? [line(i.old_string), line(i.new_string)] : tool === "Write" ? ["", str(i.content)] : [];
  if (name === undefined || before === undefined || after === undefined) return undefined;
  return { oldFile: { name, contents: before }, newFile: { name, contents: after } };
}

/** Added and removed line counts of an Edit/Write call, for the collapsed card header; undefined until the input is complete. */
export function diffStats(tool: string, input: unknown): { added: number; removed: number } | undefined {
  const files = editFiles(tool, input);
  if (!files) return undefined;
  const { hunks } = parseDiffFromFile(files.oldFile, files.newFile);
  return { added: hunks.reduce((n, h) => n + h.additionLines, 0), removed: hunks.reduce((n, h) => n + h.deletionLines, 0) };
}

/** The Artifact tools (publish, read and comment on claude.ai artifacts, artifact database); each has a card body of its own. */
export const ARTIFACT_TOOLS = new Set(["Artifact", "ArtifactComments", "ArtifactData"]);

const CLAUDE_URL = /^https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+$/;

/** True for an artifact link that may be rendered as an anchor: https://claude.ai/artifact/<id> or /code/artifact/<id>, nothing else. */
export const isClaudeUrl = (url: unknown): url is string => typeof url === "string" && CLAUDE_URL.test(url);

/** First claude.ai artifact URL in a text (a tool result); undefined when there is none. */
export function claudeUrl(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  for (const m of text.matchAll(/https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/g)) {
    if (isClaudeUrl(m[0])) return m[0];
  }
  return undefined;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Header summary of an Artifact* call: the title (or file name) of a publish, else `<Action> <target>`; never the long file path. */
export function artifactSummary(tool: string, input: unknown): string {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : "");
  const action = str("action");
  if (tool === "Artifact" && (action === "" || action === "publish")) {
    const title = str("title");
    if (title) return title.split("\n")[0]!;
    const file = str("file_path");
    return file.slice(Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")) + 1);
  }
  const verb = cap(action);
  if (tool === "ArtifactData") {
    const target = [str("collection"), str("doc_id")].filter(Boolean).join("/");
    return [verb, target].filter(Boolean).join(" ");
  }
  if (tool === "Artifact" && action === "quickstart") return str("intent") ? `${verb}: ${str("intent")}` : verb;
  return [verb, str("url")].filter(Boolean).join(" ");
}
