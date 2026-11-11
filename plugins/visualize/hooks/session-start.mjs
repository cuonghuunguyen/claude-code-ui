// SessionStart hook: hands the visualize skill (description + body) to the model as additionalContext.
// A resumed or forked session already has it in its transcript: only startup, clear and compact add it.
import { readFileSync } from "node:fs";

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {}
if (input.source === "resume" || input.source === "fork") process.exit(0);
const skill = readFileSync(new URL("../skills/visualize/SKILL.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(skill);
const desc = m && /^description:\s*(.+)$/m.exec(m[1])?.[1];
if (!desc) process.exit(0);
const additionalContext = `${desc}\n\n${m[2].trim()}`;
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }));
