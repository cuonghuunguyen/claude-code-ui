import { describe, expect, it } from "vitest";
import { showsSkeleton } from "./session-loading.ts";

const base = { view: false, listed: true, failed: false, listLoaded: true };

describe("showsSkeleton", () => {
  it("is off once the view is there", () => expect(showsSkeleton({ ...base, view: true })).toBe(false));
  it("is off after a failed subscribe", () => expect(showsSkeleton({ ...base, failed: true })).toBe(false));
  it("is on for a listed session with no view", () => expect(showsSkeleton(base)).toBe(true));
  it("is off for an unlisted session once the list is loaded", () => expect(showsSkeleton({ ...base, listed: false })).toBe(false));
  it("is on for an unlisted session while the list is not loaded", () => expect(showsSkeleton({ ...base, listed: false, listLoaded: false })).toBe(true));
});
