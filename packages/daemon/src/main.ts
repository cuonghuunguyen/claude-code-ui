import { fileURLToPath } from "node:url";
import { createDaemon } from "./server.ts";

const HOST = "127.0.0.1";
const port = Number(process.env.PORT ?? 4280);
const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));

createDaemon({ webRoot }).listen(port, HOST, () => console.log(`claude-ui daemon on http://${HOST}:${port}`));
