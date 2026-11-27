// Engine conformance suite (ADR 0012): every adapter replays recorded fixtures through a whole Session, and the Parts it emits must have the structure of one
// engine-neutral reference sequence per scenario. A feature the adapter's support table marks as a gap is skipped, the reason in the test name.
import { describe, expect, it } from "vitest";
import { gapReason, isSupported } from "@claude-ui/protocol";
import { DRIVERS } from "./drivers.ts";
import { compare, normalize, type Pattern } from "./normalize.ts";
import { SCENARIOS, type Variant } from "./scenarios.ts";

describe.each(DRIVERS)("$label", (driver) => {
  for (const scenario of SCENARIOS) {
    const gap = scenario.feature && gapReason(driver.support[scenario.feature]);
    (gap ? it.skip : it)(gap ? `${scenario.name} (gap: ${gap})` : scenario.name, async () => {
      const run = await driver.open(scenario.fixtures, { manual: scenario.manual });
      try {
        await scenario.play(run);
        const steps = normalize(run.events);
        const variants: Pattern[][] = scenario.expected.length > 0 && "steps" in scenario.expected[0]! ? (scenario.expected as Variant[]).filter((v) => v.adapters.includes(driver.adapter)).map((v) => v.steps) : [scenario.expected as Pattern[]];
        const differences = variants.map((v) => compare(steps, v, scenario.optional));
        expect(differences.some((d) => d === undefined), `${differences.join(" | ")}\nactual: ${JSON.stringify(steps)}`).toBe(true);
      } finally {
        await run.close();
      }
    }, 30_000);
  }

  // Allow and retry needs a call auto mode denied; no recording has one, so the table entry is proven by what the engine does with a call it never denied.
  it("Allow and retry follows its support table entry", async () => {
    const run = await driver.open({});
    try {
      const gap = gapReason(driver.support.deniedRetry);
      const call = () => run.session.allowDenied("never-denied");
      if (gap) expect(call).toThrow(expect.objectContaining({ code: "unsupported", message: gap }));
      else expect(call).toThrow(expect.objectContaining({ code: "unknown_call" }));
    } finally {
      await run.close();
    }
  });

  it("capability flags of the support table follow it", async () => {
    const run = await driver.open({});
    try {
      expect(run.engine.support).toBe(driver.support);
      expect(run.engine.capabilities.shell).toBe(isSupported(driver.support.shell));
    } finally {
      await run.close();
    }
  });
});
