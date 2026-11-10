/**
 * Stop of an OpenCode session (GH-682): where each send() of a prompt is, and what a Stop does there.
 *
 * A send() goes through these phases (one `SendRun` each, a steering prompt has its own):
 * - `preparing`: it waits for the event stream, the attach of the orchestration MCP server, the permission block (PATCH, plan mode's
 *   GET /agent), the effort levels and the prompt requests an earlier Stop left on their way. OpenCode does not know the prompt.
 *   Stop: `dropped`. Every wait ends at once and the prompt is never posted; what it waited for goes on (never cancelled).
 * - `posting`: its `prompt_async` (or command) request is on its way. OpenCode may run the turn already, or get the prompt only later.
 *   Stop: the send stays in `posting`; `stop()` hands its request to the session, which tells by OpenCode's status when the turn ended.
 * - `posted`: OpenCode answered (or refused) the request. Stop: OpenCode's abort ends the turn with its own events.
 * - `dropped`: a Stop came while preparing.
 * The session's side (what the turn does at a Stop) is in OpenCodeSession.interrupt().
 */
export type SendPhase = "preparing" | "posting" | "posted" | "dropped";

export class SendRun {
  phase: SendPhase = "preparing";
  /** The request while `posting`, settled whatever its outcome. */
  request: Promise<void> | undefined;
  private wake!: () => void;
  private readonly stopped = new Promise<void>((r) => (this.wake = r));

  constructor(private readonly runs: Set<SendRun>) {}

  /** Waits for `p` while preparing. False when a Stop dropped the send (at once, `p` is not awaited then and its failure is dropped). */
  async prepare(p: Promise<unknown>): Promise<boolean> {
    if (this.phase !== "preparing") return false;
    p.catch(() => {});
    await Promise.race([p, this.stopped]);
    return this.phase === "preparing";
  }

  /** The prompt request: `posting` until it settles, then `posted`. Its outcome is the caller's. */
  post<T>(p: Promise<T>): Promise<T> {
    this.phase = "posting";
    this.request = p.then(
      () => {},
      () => {},
    );
    return p.finally(() => ((this.phase = "posted"), this.runs.delete(this)));
  }

  /** The send is over without a request (it failed while preparing). */
  end() {
    if (this.phase === "preparing") this.runs.delete(this);
  }

  drop() {
    this.phase = "dropped";
    this.runs.delete(this);
    this.wake();
  }
}

export class StopControl {
  private readonly runs = new Set<SendRun>();
  /** Stops so far. A turn begun after the last Stop has `count` as its mark. */
  count = 0;

  begin(): SendRun {
    const run = new SendRun(this.runs);
    this.runs.add(run);
    return run;
  }

  /** Stop: drops every preparing send, returns the requests still on their way (each settles, never rejects). */
  stop(): Promise<void>[] {
    this.count++;
    const ways: Promise<void>[] = [];
    for (const run of [...this.runs]) {
      if (run.phase === "preparing") run.drop();
      else if (run.phase === "posting") ways.push(run.request!);
    }
    return ways;
  }
}
