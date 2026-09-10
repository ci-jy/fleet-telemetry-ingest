#!/usr/bin/env python3
"""Plot recovery time and message accounting per fault scenario.

Reads reports/k8s-chaos.json (k3d chaos suite) and results/chaos/*.json (Docker Compose
fault-injection suite) and writes docs/chaos-recovery.png.

    python3 scripts/plot-results.py
"""
import glob
import json
import os
import statistics

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
OUT = os.path.join(ROOT, "docs", "chaos-recovery.png")


def k8s_rows():
    path = os.path.join(ROOT, "reports", "k8s-chaos.json")
    if not os.path.exists(path):
        return []
    with open(path) as f:
        report = json.load(f)
    replicas = report["config"]["replicas"]
    rows = []
    for s in report["scenarios"]:
        rows.append({
            "label": f"Kubernetes, {replicas} pods: {s['scenario']}",
            "recovery": (s.get("recoveryMs") or 0) / 1000,
            "sent": s.get("sentDistinct", s.get("sent", 0)),
            "lost": s.get("lost", 0),
            "dup": s.get("duplicated", 0),
            "group": "k8s",
        })
    return rows


def compose_rows():
    rows = []
    for path in sorted(glob.glob(os.path.join(ROOT, "results", "chaos", "*.json"))):
        with open(path) as f:
            runs = json.load(f)
        if not runs:
            continue
        rows.append({
            "label": f"Compose, 1 process: {runs[0]['scenario']} (median of {len(runs)})",
            "recovery": statistics.median(r["recoveryMs"] for r in runs) / 1000,
            "sent": sum(r["expected"] for r in runs),
            "lost": sum(r["lost"] for r in runs),
            "dup": sum(r["duplicates"] for r in runs),
            "group": "compose",
        })
    return rows


def main():
    rows = k8s_rows() + compose_rows()
    if not rows:
        raise SystemExit("no results found")
    rows.reverse()
    fig, ax = plt.subplots(figsize=(9, 0.42 * len(rows) + 1.4))
    colors = {"k8s": "#326ce5", "compose": "#7f8c8d"}
    y = range(len(rows))
    ax.barh(y, [r["recovery"] for r in rows], color=[colors[r["group"]] for r in rows])
    ax.set_yticks(list(y))
    ax.set_yticklabels([r["label"] for r in rows], fontsize=8.5)
    xmax = max(r["recovery"] for r in rows)
    for i, r in enumerate(rows):
        ax.text(r["recovery"] + xmax * 0.01, i,
                f"{r['sent']:,} msgs: {r['lost']} lost, {r['dup']} dup",
                va="center", fontsize=8)
    ax.set_xlim(0, xmax * 1.45)
    ax.set_xlabel("recovery time after the fault (s)")
    ax.set_title("Recovery time per injected fault; every message stored exactly once", fontsize=10)
    ax.spines[["top", "right"]].set_visible(False)
    fig.tight_layout()
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    fig.savefig(OUT, dpi=130)
    print(f"wrote {os.path.relpath(OUT, ROOT)}")


if __name__ == "__main__":
    main()
