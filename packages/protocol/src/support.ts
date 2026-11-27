import type { EngineCapabilities } from "./wire.ts";

/** A feature an Engine adapter has or lacks (ADR 0012). Each feature the conformance suite covers is one name; the capability flag of the same name derives from the table. */
export type Feature = "shell";

/** `supported`: the adapter has it and the conformance suite proves it. `gap`: it does not, with the reason it does not. */
export type Support = "supported" | { gap: string };

/** What one adapter supports. Every adapter has an entry for every Feature: a missing entry is a type error, not a silent gap. */
export type SupportTable = Record<Feature, Support>;

export const isSupported = (s: Support): s is "supported" => s === "supported";

/** The gap's reason; undefined when supported. */
export const gapReason = (s: Support): string | undefined => (isSupported(s) ? undefined : s.gap);

/** The flags of `EngineCapabilities` that derive from the table. Other flags stay in `rest` until the table covers them. */
export const capabilitiesFromSupport = (table: SupportTable, rest: Omit<EngineCapabilities, Feature>): EngineCapabilities => ({
  ...rest,
  shell: isSupported(table.shell),
});
