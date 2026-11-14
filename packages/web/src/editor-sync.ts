import { useEffect } from "react";
import type { connect, ConnectionStatus } from "./client.ts";
type Client = ReturnType<typeof connect>;
import { useEditorSync, type EditorStore } from "./editor-store.ts";

/** The one editor sync of the shared store (disk watch, reload on change) for every Files view. */
export function EditorSync({ store, client, status, watch }: { store: EditorStore; client: Client; status: ConnectionStatus; watch: string[] }) {
  useEditorSync(store, client, status, watch, true);
  useEffect(() => void (status === "connected" && store.restore()), [status]);
  return null;
}
