// The two slash commands registered through the `config` hook. Each one only tells the session
// agent to call the matching plugin tool; the tool does the work (see tools.ts).
import { EVAL_TOOL, IMPROVE_TOOL } from "./tools.ts";

export const EVAL_COMMAND = "auto-mode-eval";
export const IMPROVE_COMMAND = "auto-mode-improve";

const EVAL_ARGS =
  "Arguments given by the user (may be empty): $ARGUMENTS\n" +
  "Map them onto the tool's arguments: a bare number is `limit`; the word `all` as a case selector is `only`; `all-projects` or `global` is `scope` \"all\"; `model=provider/model` is `model`. " +
  'Anything not given takes the neutral default: limit 0, only "labeled", scope "project", model "".';

const IMPROVE_ARGS =
  "Arguments given by the user (may be empty): $ARGUMENTS\n" +
  'A bare number is `limit`; `all-projects` or `global` is `scope` "all". Anything not given: limit 0, scope "project".';

const IMPROVE_RULES = [
  "- Split the suggestions by where they belong, and say which bucket each one is in: (1) project-specific (trusted hosts, deploy targets, repo facts; mostly `environment`), to go in this project's `opencode.json` or `.opencode` config; (2) personal, across projects, to go in `~/.config/opencode/opencode.json` plugin options; (3) candidates for the plugin's shipped defaults (patterns seen in several projects), reported only, for the maintainer.",
  "- Say which config file currently supplies the plugin options, as the report states it (or that it is unknown).",
  "- For each suggestion, name the logged examples it fixes.",
  "- Warn about every rule that would also over-allow, and about examples that are better left to the human.",
  "- Do not edit any files; only show the snippets.",
  `- End by suggesting the user run /${EVAL_COMMAND} after applying the changes.`,
].join("\n");

export const COMMANDS: Record<string, { description: string; template: string }> = {
  [EVAL_COMMAND]: {
    description: "Auto mode: replay logged decisions through the classifier with the current rules (calls the model once per case)",
    template: [
      `Call the \`${EVAL_TOOL}\` tool now, exactly once. It replays logged auto-mode decisions through the classifier with the current rules and returns a report.`,
      EVAL_ARGS,
      "Then show the report to the user as returned (it is already compact; do not reformat it or repeat the table), and add at most two sentences on what it implies. Do not edit any files and do not call other tools.",
    ].join("\n\n"),
  },
  [IMPROVE_COMMAND]: {
    description: "Auto mode: propose rule changes (allow/softDeny/environment) from the cases the human overrode",
    template: [
      `Call the \`${IMPROVE_TOOL}\` tool now, exactly once. It returns the current effective auto-mode rules and the logged cases where the human overrode or filled in for the classifier.`,
      IMPROVE_ARGS,
      "Then propose concrete rule changes as an `opencode.json` plugin-options snippet for the auto-mode plugin: additions to, or rewordings of, `allow`, `softDeny` and `environment` bullets. Rules for the answer:\n" + IMPROVE_RULES,
    ].join("\n\n"),
  },
};
