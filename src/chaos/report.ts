import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { RunResult } from "./runner.js";

export const RESULTS_DIR = "results/chaos";

export function writeScenarioResults(scenario: string, results: RunResult[], dir = RESULTS_DIR): string {
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/${scenario}.json`;
  writeFileSync(file, JSON.stringify(results, null, 2) + "\n");
  return file;
}

export function loadAllResults(dir = RESULTS_DIR): RunResult[] {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "summary.json");
  } catch {
    return [];
  }
  return files.flatMap((f) => JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) as RunResult[]);
}

const fmt = (ms: number | null): string => (ms === null ? "–" : (ms / 1000).toFixed(2));
const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)]!;
};

/** Markdown: one row per scenario and seed, then one summary row per scenario. */
export function resultsTable(results: RunResult[], order: string[] = []): string {
  const rank = (s: string) => (order.indexOf(s) === -1 ? order.length : order.indexOf(s));
  const sorted = [...results].sort((a, b) => rank(a.scenario) - rank(b.scenario) || a.seed - b.seed);
  const lines = [
    "| Scenario | Seed | Messages delivered | Unique | Lost | Duplicate rows | Trips (match fault-free) | Downtime s | Recovery s | Catch-up s | Peak queue | Paused | Failed batches | Result |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- | ---: | --- |",
  ];
  for (const r of sorted) {
    lines.push(
      `| ${r.scenario} | ${r.seed} | ${r.deliveries} | ${r.expected} | ${r.lost} | ${r.duplicates + r.duplicateTrips} | ` +
        `${r.trips} (${r.tripsMatch ? "yes" : "NO"}) | ${fmt(r.downtimeMs)} | ${fmt(r.recoveryMs)} | ${fmt(r.catchUpMs)} | ` +
        `${r.peakQueueDepth} / ${r.queueCapacity} | ${r.paused ? "yes" : "no"} | ${r.batchErrors} | ${r.ok ? "pass" : "FAIL"} |`,
    );
  }
  const summary = [
    "| Scenario | Runs | Passed | Lost | Duplicate rows | Trips identical | Median recovery s | Max recovery s | Median catch-up s | Max peak queue |",
    "| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |",
  ];
  const names = [...new Set(sorted.map((r) => r.scenario))];
  for (const n of names) {
    const rs = sorted.filter((r) => r.scenario === n);
    const rec = rs.map((r) => r.recoveryMs).filter((x): x is number => x !== null);
    const cu = rs.map((r) => r.catchUpMs).filter((x): x is number => x !== null);
    summary.push(
      `| ${n} | ${rs.length} | ${rs.filter((r) => r.ok).length} | ${rs.reduce((a, r) => a + r.lost, 0)} | ` +
        `${rs.reduce((a, r) => a + r.duplicates + r.duplicateTrips, 0)} | ${rs.every((r) => r.tripsMatch) ? "all" : "NO"} | ` +
        `${fmt(median(rec))} | ${fmt(rec.length ? Math.max(...rec) : null)} | ${fmt(median(cu))} | ${Math.max(...rs.map((r) => r.peakQueueDepth))} |`,
    );
  }
  return `${summary.join("\n")}\n\n${lines.join("\n")}\n`;
}

export function writeSummary(results: RunResult[], order: string[], dir = RESULTS_DIR): string {
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/summary.md`;
  writeFileSync(file, resultsTable(results, order));
  return file;
}
