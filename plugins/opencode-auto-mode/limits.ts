// Per-session denial limits: stop auto-deciding once a session hits too many consecutive or
// total blocks, so a confused classifier can't wedge a session forever. An allow resets the
// consecutive counter; the total counter never resets.

export interface LimitsOptions {
  maxConsecutiveBlocks: number;
  maxTotalBlocks: number;
}

interface SessionState {
  consecutive: number;
  total: number;
  stopped: boolean;
}

export interface Limits {
  /** True once this session hit a limit: the plugin must stop auto-deciding for it. */
  isStopped(sessionID: string): boolean;
  /** An allow: resets the consecutive-block counter. */
  recordAllow(sessionID: string): void;
  /** A block: returns true the moment a limit is crossed (caller toasts once, then). */
  recordBlock(sessionID: string): boolean;
  /** Test/debug seam. */
  reset(sessionID: string): void;
}

export function createLimits(opts: LimitsOptions): Limits {
  const sessions = new Map<string, SessionState>();
  function state(sessionID: string): SessionState {
    let s = sessions.get(sessionID);
    if (!s) {
      s = { consecutive: 0, total: 0, stopped: false };
      sessions.set(sessionID, s);
    }
    return s;
  }
  return {
    isStopped: (sessionID) => sessions.get(sessionID)?.stopped ?? false,
    recordAllow(sessionID) {
      state(sessionID).consecutive = 0;
    },
    recordBlock(sessionID) {
      const s = state(sessionID);
      if (s.stopped) return false;
      s.consecutive += 1;
      s.total += 1;
      if (s.consecutive >= opts.maxConsecutiveBlocks || s.total >= opts.maxTotalBlocks) {
        s.stopped = true;
        return true;
      }
      return false;
    },
    reset(sessionID) {
      sessions.delete(sessionID);
    },
  };
}
