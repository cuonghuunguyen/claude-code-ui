// Every scene by name: the key is the PNG name. Add a scene file here to make `npm run docs:shots` capture it.
import type { Scene } from "./scene.ts";
import { scene as focus } from "./scenes/focus.ts";
import { scene as newSession } from "./scenes/new-session.ts";
import { scene as permissions } from "./scenes/permissions.ts";

export const SCENES: Record<string, Scene> = { permissions, focus, "new-session": newSession };
