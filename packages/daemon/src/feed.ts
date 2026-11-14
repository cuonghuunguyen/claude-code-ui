import type { Event } from "@claude-ui/protocol";

/**
 * Per-connection send feeds with backpressure (GH-767). A session's events went into the socket whatever its buffer held: on a slow link
 * the daemon queued more than the link carried (26 MB written to a socket that delivered 11 MB), every reply and the ping waited behind it, and
 * the queue died with the socket. A feed sends at once while the connection's buffer is below HIGH; above it the feed pauses and keeps the seq it
 * sent. A timer, running only while a feed is paused, resumes the feeds once the buffer fell below LOW, from the session log: the log keeps only
 * the latest event of a streamed part, so what piled up while paused is coalesced for free. Replies and broadcasts are never held.
 */
export const FEED_HIGH = 256 * 1024;
export const FEED_LOW = 64 * 1024;
export const FEED_POLL_MS = 50;
/** Events a background feed sends per round of a resume: the background feeds take turns. */
const SLICE = 50;

/** What a feed needs of a session. */
export interface FeedSource {
  /** The events with seq > `seq`, in order. */
  eventsAfter(seq: number): Iterable<Event>;
  /** Follows new events only (`replay` false); returns the unsubscribe. */
  subscribe(sinceSeq: number, listener: (e: Event) => void, replay?: boolean): () => void;
}
/** What a feed needs of the connection. */
export interface FeedConn {
  readonly OPEN: number;
  readonly readyState: number;
  readonly bufferedAmount: number;
}
export interface FeedOptions {
  high?: number;
  low?: number;
  pollMs?: number;
}

interface Feed {
  source: FeedSource;
  /** Seq of the last event sent; the resume continues after it. */
  sentSeq: number;
  paused: boolean;
  /** A shown tab (plain subscribe): resumes before the background feeds. */
  held: boolean;
  /** Smaller goes first among the shown feeds: the order the page asked in (the daemon handles subscribes concurrently, they finish in any order). */
  order: number;
  stop: () => void;
}

export function createFeeds(conn: FeedConn, send: (e: Event) => void, o: FeedOptions = {}) {
  const high = o.high ?? FEED_HIGH;
  const low = o.low ?? FEED_LOW;
  const feeds = new Set<Feed>();
  let timer: NodeJS.Timeout | undefined;
  let turn = 0;
  let count = 0;

  /** Sends the events after the feed's seq until the buffer is above HIGH (`paused`), `max` events were sent, or none are left. Returns whether the feed is caught up. */
  function pump(f: Feed, max = Infinity): boolean {
    let sent = 0;
    for (const e of f.source.eventsAfter(f.sentSeq)) {
      if (conn.readyState !== conn.OPEN) return false;
      if (conn.bufferedAmount > high) return pause(f);
      if (sent >= max) return false;
      send(e);
      f.sentSeq = e.seq;
      sent++;
    }
    f.paused = false;
    return true;
  }
  function pause(f: Feed): false {
    f.paused = true;
    timer ??= setInterval(tick, o.pollMs ?? FEED_POLL_MS).unref();
    return false;
  }
  function idle() {
    if (timer && ![...feeds].some((f) => f.paused)) (clearInterval(timer), (timer = undefined));
  }
  /** Gives each paused feed of `list` SLICE events per round, from index `start`, until the buffer is above HIGH or all caught up. */
  function rounds(list: Feed[], start: number) {
    for (let more = list.length > 0; more && conn.readyState === conn.OPEN && conn.bufferedAmount <= high; ) {
      more = false;
      for (let i = 0; i < list.length && conn.bufferedAmount <= high; i++) {
        const f = list[(i + start) % list.length]!;
        if (!f.paused) continue;
        pump(f, SLICE);
        more ||= f.paused;
      }
    }
  }
  /**
   * Resumes the paused feeds once the buffer drained: the first shown tab (the visible one) fully, the other shown tabs in turns of SLICE
   * events in the order they were subscribed, then the background feeds in turns, whose first one differs from tick to tick.
   */
  function tick() {
    if (conn.readyState !== conn.OPEN) return void (clearInterval(timer), (timer = undefined));
    if (conn.bufferedAmount >= low) return;
    const paused = [...feeds].filter((f) => f.paused);
    // The first shown feed is the visible tab (the page subscribes it first): it catches up before the others get a turn.
    const shown = paused.filter((f) => f.held).sort((a, b) => a.order - b.order);
    if (shown[0] && conn.bufferedAmount <= high) pump(shown[0]);
    rounds(shown.slice(1), 0);
    rounds(paused.filter((f) => !f.held), turn++);
    idle();
  }

  return {
    /** `order`: the place of the request among this connection's subscribes (feed order of the shown tabs); absent: the call order. Sends the events of `source` after `since` as the buffer allows, then follows it. Returns the stop: ends the feed, the subscription and the timer when no feed is paused. */
    follow(source: FeedSource, since: number, held: boolean, order = ++count): () => void {
      const f: Feed = { source, sentSeq: since, paused: false, held, order, stop: () => {} };
      feeds.add(f);
      // The replay goes through the feed, not the subscription: a long gap is written in pieces.
      const unsubscribe = source.subscribe(since, (e) => {
        if (f.paused) return; // the log has it; the resume sends it
        if (conn.bufferedAmount > high) return void pause(f);
        send(e);
        f.sentSeq = e.seq;
      }, false);
      f.stop = () => {
        unsubscribe();
        feeds.delete(f);
        idle();
      };
      pump(f);
      return f.stop;
    },
    /** Paused feeds right now (tests). */
    paused: () => [...feeds].filter((f) => f.paused).length,
    /** Stops every feed (connection closed). */
    close() {
      for (const f of [...feeds]) f.stop();
    },
  };
}
