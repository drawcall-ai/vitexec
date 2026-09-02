"""Per-run summary of harness.log: the last instrumentation line of each vitexec run."""
import json
import sys
from pathlib import Path

log = Path(__file__).with_name("harness.log")
runs: list[tuple[str, dict | None]] = []
for line in log.read_text().splitlines():
    if line.startswith("=== run "):
        runs.append((line[8:], None))
        continue
    if line.startswith("[log] [harness] ") and runs:
        runs[-1] = (runs[-1][0], json.loads(line[len("[log] [harness] "):]))

start = int(sys.argv[1]) if len(sys.argv) > 1 else 0
for index, (header, last) in enumerate(runs[start:], start):
    if last is None:
        print(f"{index:3d} {header[:70]:70s} (no instrumentation lines)")
        continue
    print(
        f"{index:3d} {header[:70]:70s} phase={last['phase']} won={last['won']} "
        f"t={last['matchTime']} shots={last['shots']} hits={last['hits']} "
        f"kills={last['kills']} acc={last['accuracy']}"
    )
