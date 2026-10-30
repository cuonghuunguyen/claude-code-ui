// Every scene by name: the key is the PNG name. Add a scene file here to make `npm run docs:shots` capture it.
import type { Scene } from "./scene.ts";
import { scene as focus } from "./scenes/focus.ts";
import { scene as newSession } from "./scenes/new-session.ts";
import { scene as files } from "./scenes/files.ts";
import { scene as groupMenu } from "./scenes/group-menu.ts";
import { scene as sessionsScene } from "./scenes/sessions.ts";
import { scene as terminal } from "./scenes/terminal.ts";
import { scene as permissions } from "./scenes/permissions.ts";
import { scene as settings } from "./scenes/settings.ts";

export const SCENES: Record<string, Scene> = { permissions, focus, "new-session": newSession, files, terminal, sessions: sessionsScene, "group-menu": groupMenu, settings };
