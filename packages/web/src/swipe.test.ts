import { describe, expect, it } from "vitest";
import { ROW_SWIPE, mirror, opacityFor, rubber, swipe, type Sample, type SwipeConfig, type SwipeState } from "./swipe.ts";

const SIZE = 300;
const at = (x: number, y: number, t: number): Sample => ({ x, y, t });
/** Runs a touch: down at (0,0), then moves, then up at the last point (or `up`). */
function run(points: [number, number, number][], cfg: SwipeConfig = ROW_SWIPE, size = SIZE, end: "up" | "cancel" | "none" = "up") {
  let s: SwipeState = { phase: "idle" };
  s = swipe(s, { type: "down", p: at(0, 0, 0) }, cfg, size);
  const trail: SwipeState[] = [s];
  for (const [x, y, t] of points) trail.push((s = swipe(s, { type: "move", p: at(x, y, t) }, cfg, size)));
  if (end === "up") {
    const last = points.at(-1) ?? [0, 0, 0];
    trail.push((s = swipe(s, { type: "up", p: at(last[0], last[1], last[2] + 1) }, cfg, size)));
  } else if (end === "cancel") trail.push((s = swipe(s, { type: "cancel" }, cfg, size)));
  return { s, trail };
}
/** A steady drag of `dx` px over `ms`, in 16 ms steps. */
const drag = (dx: number, ms: number, dy = 0): [number, number, number][] => {
  const n = Math.max(1, Math.round(ms / 16));
  return Array.from({ length: n }, (_, i) => [(dx * (i + 1)) / n, (dy * (i + 1)) / n, 16 * (i + 1)] as [number, number, number]);
};

describe("direction lock", () => {
  it("stays pending below the slop", () => {
    const { s } = run([[4, 3, 16]], ROW_SWIPE, SIZE, "none");
    expect(s.phase).toBe("pending");
  });

  it("a small jitter then a clean horizontal move locks x and drags without a jump", () => {
    const { trail } = run([[2, 3, 16], [-3, 1, 32], [-12, 1, 48], [-30, 2, 64]], ROW_SWIPE, SIZE, "none");
    expect(trail[2]!.phase).toBe("pending");
    const first = trail[3]!;
    expect(first.phase).toBe("dragging");
    // Offset at the lock is the distance past the slop: 12 - 10.
    expect(first.phase === "dragging" && first.offset).toBe(-2);
    expect(trail[4]!.phase === "dragging" && trail[4]!.offset).toBe(-20);
  });

  it("a vertical move locks y: the row is left to the browser, and the touch never becomes x later", () => {
    const { trail, s } = run([[1, 14, 16], [-80, 40, 32], [-200, 60, 48]], ROW_SWIPE, SIZE, "none");
    expect(trail[1]!.phase).toBe("ignored");
    expect(s.phase).toBe("ignored");
    expect(swipe(s, { type: "up", p: at(-200, 60, 60) }, ROW_SWIPE, SIZE).phase).toBe("cancelled");
  });

  it("a diagonal waits until 20 px, then the larger component wins", () => {
    const wait = run([[11, 10, 16]], ROW_SWIPE, SIZE, "none");
    expect(wait.s.phase).toBe("pending");
    expect(run([[11, 10, 16], [-22, 18, 32]], ROW_SWIPE, SIZE, "none").s.phase).toBe("dragging");
    expect(run([[11, 10, 16], [-18, 22, 32]], ROW_SWIPE, SIZE, "none").s.phase).toBe("ignored");
  });
});

describe("tap", () => {
  it("up while pending within 500 ms is a tap, later it is cancelled (a long press)", () => {
    let s = swipe({ phase: "idle" }, { type: "down", p: at(0, 0, 0) }, ROW_SWIPE, SIZE);
    expect(swipe(s, { type: "up", p: at(1, 1, 120) }, ROW_SWIPE, SIZE).phase).toBe("tap");
    s = swipe({ phase: "idle" }, { type: "down", p: at(0, 0, 0) }, ROW_SWIPE, SIZE);
    expect(swipe(s, { type: "up", p: at(1, 1, 520) }, ROW_SWIPE, SIZE).phase).toBe("cancelled");
  });
});

describe("left swipe on a row", () => {
  it("commits past 40% of the width", () => {
    const { s } = run(drag(-130, 800));
    expect(s).toMatchObject({ phase: "committed", dir: -1 });
  });

  it("commits at commitMin on a narrow row", () => {
    expect(run(drag(-80, 800), ROW_SWIPE, 100).s.phase).toBe("committed");
    expect(run(drag(-60, 800), ROW_SWIPE, 100).s.phase).toBe("settling");
  });

  it("commits on a fast 30 px flick, not on a slow 30 px move", () => {
    expect(run(drag(-40, 48)).s.phase).toBe("committed");
    expect(run(drag(-40, 800)).s.phase).toBe("settling");
  });

  it("a short slow drag settles back", () => {
    expect(run(drag(-50, 600)).s.phase).toBe("settling");
  });

  it("left then back right past 0 follows the finger and does not commit", () => {
    const pts: [number, number, number][] = [...drag(-150, 400), [-60, 0, 480], [30, 0, 560], [40, 0, 640]];
    const { s, trail } = run(pts);
    expect(s.phase).toBe("settling");
    const back = trail.at(-3)!;
    expect(back.phase === "dragging" && back.offset).toBeGreaterThan(0);
  });

  it("a flick against the offset direction does not commit", () => {
    const pts: [number, number, number][] = [...drag(-35, 600), [-10, 0, 700], [10, 0, 716], [-5, 0, 732], [-30, 0, 748]];
    // Ends at -30 px (after the slop -20) moving left fast, but too short: settles.
    expect(run(pts).s.phase).toBe("settling");
    // Left at -80 px (past commitMin, short of 40%), then a fast move back to the right: no flick, no distance commit.
    const away: [number, number, number][] = [...drag(-150, 600), [-130, 0, 700], [-100, 0, 716], [-80, 0, 732]];
    expect(run(away).s.phase).toBe("settling");
  });
});

describe("right swipe on a row", () => {
  it("never commits, whatever its length or speed, and its shown offset stays within the rubber band", () => {
    for (const [dx, ms] of [[200, 800], [250, 40], [900, 16], [60, 20]] as const) {
      const { s, trail } = run(drag(dx, ms));
      expect(s.phase).toBe("settling");
      for (const st of trail) if (st.phase === "dragging") expect(Math.abs(st.offset)).toBeLessThanOrEqual(ROW_SWIPE.rubberLimit);
    }
  });

  it("shows a positive, growing, bounded offset", () => {
    const { trail } = run(drag(200, 400), ROW_SWIPE, SIZE, "none");
    const shown = trail.flatMap((s) => (s.phase === "dragging" ? [s.offset] : []));
    expect(shown.length).toBeGreaterThan(3);
    expect(shown[0]).toBeGreaterThan(0);
    for (let i = 1; i < shown.length; i++) expect(shown[i]!).toBeGreaterThanOrEqual(shown[i - 1]!);
    expect(shown.at(-1)!).toBeLessThan(16);
  });
});

describe("RTL", () => {
  it("mirrors: right commits, left rubber-bands", () => {
    const cfg = { ...ROW_SWIPE, allow: mirror(ROW_SWIPE.allow) };
    expect(cfg.allow).toBe("positive");
    expect(run(drag(150, 800), cfg).s).toMatchObject({ phase: "committed", dir: 1 });
    expect(run(drag(-150, 800), cfg).s.phase).toBe("settling");
    expect(mirror("both")).toBe("both");
    expect(mirror("none")).toBe("none");
  });
});

describe("cancel", () => {
  it("settles from pending and from dragging", () => {
    expect(run(drag(-60, 400), ROW_SWIPE, SIZE, "cancel").s.phase).toBe("settling");
    expect(run([], ROW_SWIPE, SIZE, "cancel").s.phase).toBe("settling");
  });
});

describe("helpers", () => {
  it("rubber is monotonic, signed and below its limit", () => {
    let prev = 0;
    for (const v of [1, 5, 20, 80, 400, 4000]) {
      const r = rubber(v, 16);
      expect(r).toBeGreaterThan(prev);
      expect(r).toBeLessThan(16);
      expect(rubber(-v, 16)).toBe(-r);
      prev = r;
    }
    expect(rubber(0, 16)).toBe(0);
  });

  it("opacityFor fades to half over the row width", () => {
    expect(opacityFor(0, 300)).toBe(1);
    expect(opacityFor(-150, 300)).toBe(0.75);
    expect(opacityFor(-600, 300)).toBe(0.5);
  });
});

describe("vertical (trigger) config", () => {
  const Y: SwipeConfig = { ...ROW_SWIPE, axis: "y", allow: "both", commitFraction: 0.5, commitMin: 24, flickVelocity: 0.4, flickMin: 12, rubberLimit: 12 };
  it("commits at 24 px up or down, a flick over 12 px, and ignores a horizontal lock", () => {
    expect(run(drag(0, 400, -40), Y, 44).s).toMatchObject({ phase: "committed", dir: -1 });
    expect(run(drag(0, 400, 40), Y, 44).s).toMatchObject({ phase: "committed", dir: 1 });
    expect(run(drag(0, 400, -20), Y, 44).s.phase).toBe("settling");
    expect(run(drag(0, 40, -26), Y, 44).s.phase).toBe("committed");
    expect(run(drag(60, 400, 0), Y, 44, "none").s.phase).toBe("ignored");
  });
  it("a blocked direction rubber-bands within 12 px and never commits", () => {
    const cfg: SwipeConfig = { ...Y, allow: "positive" };
    const { s, trail } = run(drag(0, 300, -90), cfg, 44);
    expect(s.phase).toBe("settling");
    for (const st of trail) if (st.phase === "dragging") expect(Math.abs(st.offset)).toBeLessThanOrEqual(12);
  });
});
