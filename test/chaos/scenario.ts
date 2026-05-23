import { afterAll, describe, expect, it } from "vitest";
import { ChaosEnv, DEFAULT_RUN, type RunResult, type Scenario } from "../../src/chaos/runner.js";
import { writeScenarioResults } from "../../src/chaos/report.js";

/** Seeds to run each scenario with: CHAOS_SEEDS=5 runs seeds 1..5 (the default). */
export const seeds = (): number[] => {
  const n = Number(process.env.CHAOS_SEEDS ?? 5);
  const first = Number(process.env.CHAOS_FIRST_SEED ?? 1);
  return Array.from({ length: n }, (_, i) => first + i);
};

/**
 * Declares one test per seed for a scenario. Each run must store every delivered message exactly
 * once and produce exactly the trips, idle segments and late flags of the fault-free run.
 */
export function describeScenario(scenario: Scenario): void {
  describe(scenario.title, () => {
    const env = new ChaosEnv((m) => console.log(`[chaos] ${m}`));
    const results: RunResult[] = [];
    afterAll(async () => {
      if (results.length > 0) writeScenarioResults(scenario.name, results);
      await env.database().then((db) => db.close()).catch(() => undefined);
    });

    for (const seed of seeds()) {
      it(`seed ${seed}: no lost or duplicate messages, trips identical to the fault-free run`, async () => {
        const r = await env.run(scenario, { ...DEFAULT_RUN, seed });
        results.push(r);
        expect(r.extraFailures).toEqual([]);
        expect(r.lost, r.examples.join(", ")).toBe(0);
        expect(r.duplicates).toBe(0);
        expect(r.duplicateTrips).toBe(0);
        expect(r.phantom).toBe(0);
        expect(r.stored).toBe(r.expected);
        expect(r.tripDiffs).toEqual([]);
        expect(r.tripsMatch).toBe(true);
        // The service really was interrupted and came back.
        expect(r.recoveryMs).not.toBeNull();
      });
    }
  });
}
