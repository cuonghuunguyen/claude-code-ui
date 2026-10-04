// Incremental read of a session's JSONL transcript: each read parses only the lines the CLI appended since the last one.
import { open } from "node:fs/promises";
import type { SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";

/**
 * Parsed lines of one JSONL file, read on from the last read's offset. A cut last line (a write in progress) waits for the
 * next read; a shorter or replaced file is read again from the start. Unparsable lines are skipped, as the SDK does.
 * ponytail: holds every entry in memory while the session is mirrored (a 43 MB transcript: ~100 MB heap).
 */
export class JsonlTail {
  entries: SessionStoreEntry[] = [];
  private offset = 0;
  private ino?: number;

  async read(file: string) {
    const fh = await open(file, "r");
    try {
      const { size, ino } = await fh.stat();
      if (size < this.offset || ino !== this.ino) Object.assign(this, { entries: [], offset: 0, ino });
      if (size === this.offset) return;
      const buf = Buffer.alloc(size - this.offset);
      const { bytesRead } = await fh.read(buf, 0, buf.length, this.offset);
      const end = buf.lastIndexOf(10, bytesRead - 1);
      if (end < 0) return;
      for (const l of buf.toString("utf8", 0, end).split("\n")) {
        if (!l.trim()) continue;
        try {
          this.entries.push(JSON.parse(l));
        } catch {
          // Not JSON.
        }
      }
      this.offset += end + 1;
    } finally {
      await fh.close();
    }
  }

  /** A read-only SDK session store over the entries: getSessionMessages() builds the chain without reading the file again. */
  store(): SessionStore {
    return { load: async () => this.entries, append: async () => {} };
  }
}
