// The handler of /example:cmd (a hidden frame): puts a sample prompt in the prompt box. It never sends it.
import { call, on } from "./bridge.js";

on("command.run", (m) => {
  if (m.name === "cmd") call("prompt.insert", { text: `Summarise this session${m.args ? `: ${m.args}` : ""}` });
});
