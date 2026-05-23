import { ChaosEnv } from "../../src/chaos/runner.js";
import { loadAllResults, writeSummary } from "../../src/chaos/report.js";
import { SCENARIOS } from "../../src/chaos/scenarios.js";

const log = (m: string) => console.log(`[chaos] ${m}`);

/** Starts the Compose environment once for all scenario files and tears it down afterwards. */
export default async function setup(): Promise<() => Promise<void>> {
  const env = new ChaosEnv(log);
  await env.up();
  return async () => {
    log(`results table: ${writeSummary(loadAllResults(), SCENARIOS.map((s) => s.name))}`);
    if (process.env.CHAOS_KEEP === "1") log("CHAOS_KEEP=1: leaving the environment running");
    else await env.down();
  };
}
