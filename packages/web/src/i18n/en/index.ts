// English: the source catalog. Its keys are the key type; every other locale has the same keys (i18n.test.ts).
import app from "./app.ts";
import common from "./common.ts";
import files from "./files.ts";
import session from "./session.ts";
import settings from "./settings.ts";
import sidebar from "./sidebar.ts";

export default { name: "English", messages: { ...common, ...settings, ...app, ...sidebar, ...files, ...session } };
