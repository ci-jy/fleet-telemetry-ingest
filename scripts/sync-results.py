#!/usr/bin/env python3
"""Copy the measured chaos results into the docs so they always match the committed reports.

- README.md: the k3d results block (between the k8s-chaos markers) and the recovery range in the
  "Results in detail" row are rebuilt from reports/k8s-chaos.json; the headline recovery bound of
  the fault-injection suite is rebuilt from results/chaos/*.json.
- docs/RESILIENCE.md: the tables between the chaos-summary markers are replaced by
  results/chaos/summary.md.
- docs/chaos-recovery.png is redrawn when matplotlib is installed.

scripts/k8s-e2e.sh and the fault-injection suite run this after writing their reports.

    python3 scripts/sync-results.py
"""
import glob
import json
import math
import os
import re
import subprocess
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
README = os.path.join(ROOT, "README.md")
RESILIENCE = os.path.join(ROOT, "docs", "RESILIENCE.md")


def read(path):
    with open(path) as f:
        return f.read()


def write_if_changed(path, old, new):
    if new != old:
        with open(path, "w") as f:
            f.write(new)
        print(f"updated {os.path.relpath(path, ROOT)}")


def replace_block(text, name, body):
    pattern = re.compile(rf"(<!-- {name}:start[^>]*-->\n)(.*?)(<!-- {name}:end -->)", re.S)
    if not pattern.search(text):
        sys.exit(f"marker block {name} not found")
    return pattern.sub(lambda m: m.group(1) + body + m.group(3), text, count=1)


def seconds(ms):
    s = ms / 1000
    return f"{s:.2f} s" if s < 0.1 else f"{s:.1f} s"


def k8s_block(r):
    c = r["config"]
    lines = [
        f"Measured with `--{r.get('mode', 'quick')}` ({c['replicas']} replicas, {c['partitions']} partitions, "
        f"{c['devices']} vehicles, {c['rate']} msg/s, seed {c['seed']}; the whole",
        f"script took {r['wallClockS']} s including cluster creation, inside a 3 GB node limit):",
        "",
        "| Scenario | Sent | Distinct | Stored | Lost | Duplicated | Recovery |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    labels = {"pod-kill": None, "scale": None}
    for s in r["scenarios"]:
        name = f"`{s['scenario']}`"
        if s["scenario"] == "pod-kill":
            name += f" ({sum(a.startswith('killed') for a in s['actions'])} kills)"
        elif s["scenario"] == "scale":
            targets = [re.search(r"scaled to (\d+)", a).group(1) for a in s["actions"] if a.startswith("scaled to")]
            name += " " + " → ".join([str(c["replicas"])] + targets)
        lines.append(
            f"| {name} | {s['sent']:,} | {s['sentDistinct']:,} | {s['stored']:,} | {s['lost']} | "
            f"{s['duplicated']} | {seconds(s['recoveryMs'])} |")
    t = r["totals"]
    distinct = sum(s["sentDistinct"] for s in r["scenarios"])
    lines.append(f"| **total** | {t['sent']:,} | {distinct:,} | {t['stored']:,} | {t['lost']} | {t['duplicated']} | |")
    p = r.get("prometheus") or {}
    lines += [
        "",
        "The message counts are fixed by the seed; recovery times vary from run to run.",
        "\"Sent\" includes the simulator's deliberate duplicates. Prometheus had an `up` target for "
        f"{p.get('targetsUp')} of {p.get('ingestPods')}",
        f"ingest pods with all {len(p.get('alertRules', []))} alert rules loaded, and reported a p95 "
        f"publish-to-commit latency of {p.get('p95PublishToCommitSeconds', 0):.1f} s",
        "over the run (the chaos replay publishes faster than real time and pauses during faults).",
        "",
    ]
    return "\n".join(lines)


def main():
    readme = read(README)
    new = readme
    k8s_path = os.path.join(ROOT, "reports", "k8s-chaos.json")
    if os.path.exists(k8s_path):
        r = json.loads(read(k8s_path))
        new = replace_block(new, "k8s-chaos", k8s_block(r))
        rec = [s["recoveryMs"] for s in r["scenarios"]]
        rng = f"recovery {seconds(min(rec)).removesuffix(' s')}–{seconds(max(rec))} per scenario"
        new = re.sub(r"recovery [0-9.]+–[0-9.]+ s per scenario", rng, new, count=1)
    runs = [run for f in sorted(glob.glob(os.path.join(ROOT, "results", "chaos", "*.json")))
            for run in json.loads(read(f))]
    if runs:
        bound = math.ceil(max(run["recoveryMs"] for run in runs) / 100) / 10
        new = re.sub(r"recovery within [0-9.]+ s", f"recovery within {bound:.1f} s", new, count=1)
    write_if_changed(README, readme, new)

    summary_path = os.path.join(ROOT, "results", "chaos", "summary.md")
    if os.path.exists(summary_path):
        resilience = read(RESILIENCE)
        summary = read(summary_path).rstrip("\n") + "\n"
        if "| – |" in summary:
            summary += '\n"–" means the catch-up point was not captured by the 50 ms sampler in that run.\n'
        write_if_changed(RESILIENCE, resilience, replace_block(resilience, "chaos-summary", summary))

    try:
        import matplotlib  # noqa: F401
    except ImportError:
        print("matplotlib not installed; docs/chaos-recovery.png not redrawn")
        return
    subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "plot-results.py")], check=True)


if __name__ == "__main__":
    main()
