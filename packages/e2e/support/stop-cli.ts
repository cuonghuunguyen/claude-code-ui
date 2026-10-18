import { resolve } from "node:path";
import { stopRun } from "./stop.ts";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: npm run e2e:stop -- <absolute run folder>   (printed as 'e2e run folder:' at the top of the run's log)");
  process.exit(2);
}
for (const line of stopRun(resolve(dir))) console.log(line);
