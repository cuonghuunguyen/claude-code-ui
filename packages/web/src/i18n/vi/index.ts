import type { Catalog } from "../../i18n.ts";
import app from "./app.ts";
import common from "./common.ts";
import files from "./files.ts";
import session from "./session.ts";
import settings from "./settings.ts";
import sidebar from "./sidebar.ts";

export default { name: "Tiếng Việt", messages: { ...common, ...settings, ...app, ...sidebar, ...files, ...session } } satisfies Catalog;
