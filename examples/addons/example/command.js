// @ts-check
// The handler of /example:cmd (a hidden frame): puts a sample prompt in the prompt box. It never sends it.
import { insertPrompt, on } from "./claude-ui-addon.js";

on("command.run", (m) => {
  if (m.name === "cmd") insertPrompt(`Summarise this session${m.args ? `: ${m.args}` : ""}`);
});
