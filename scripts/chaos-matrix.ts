/**
 * Runs every fault scenario over several seeds against the Compose environment and writes the
 * results: results/chaos/<scenario>.json per scenario and results/chaos/summary.md as a table.
 *
 *   npm run chaos:matrix -- --seeds 5 [--first-seed 1] [--scenarios sigkill-ingest,db-partition] [--keep]
 *
 * Needs Docker. Exits non-zero if any run lost or duplicated a message or changed a trip.
 */
import { ChaosEnv, DEFAULT_RUN, type RunResult } from "../src/chaos/runner.js";
import { writeScenarioResults, writeSummary, loadAllResults } from "../src/chaos/report.js";
import { SCENARIOS } from "../src/chaos/scenarios.js";
import { numArg, parseArgs } from "./args.js";

const args = parseArgs();
const seeds = numArg(args, "seeds", 5);
const firstSeed = numArg(args, "first-seed", 1);
const only = args.get("scenarios")?.split(",");
const scenarios = only ? SCENARIOS.filter((s) => only.includes(s.name)) : SCENARIOS;
if (scenarios.length === 0) throw new Error(`no scenario matches ${only?.join(",")}`);

const env = new ChaosEnv((m) => console.log(m));
await env.up();
let failed = 0;
try {
  for (const scenario of scenarios) {
    const results: RunResult[] = [];
    for (let seed = firstSeed; seed < firstSeed + seeds; seed++) {
      const r = await env.run(scenario, { ...DEFAULT_RUN, seed });
      results.push(r);
      if (!r.ok) failed++;
    }
    console.log(`wrote ${writeScenarioResults(scenario.name, results)}`);
  }
} finally {
  if (!args.has("keep")) await env.down();
}
console.log(`wrote ${writeSummary(loadAllResults(), SCENARIOS.map((s) => s.name))}`);
if (failed > 0) {
  console.error(`${failed} run(s) failed`);
  process.exitCode = 1;
}
