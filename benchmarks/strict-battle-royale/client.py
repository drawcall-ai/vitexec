"""Local `vitexec` stand-in for the agent's template copy: ships the strict
script to the remote T4 harness and prints the streamed output. Only strict
runs are allowed; app files never leave this machine, so edits to the game
cannot reach the run."""
import base64
import sys
from pathlib import Path

import modal

VALUE_FLAGS = {"--path", "--timeout", "--screenshot", "--record", "--viewport", "--config"}
HARNESS_LOG = Path(__file__).with_name("harness.log")  # instrumentation lines, hidden from the agent


def main(argv: list[str]) -> int:
    args: list[str] = []
    positional: list[str] = []
    artifacts: dict[str, Path] = {}
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg in VALUE_FLAGS:
            value = argv[i + 1]
            if arg in ("--screenshot", "--record"):
                artifacts[arg] = Path(value)
                args += [arg, value]
            elif arg == "--config":
                pass
            else:
                args += [arg, value]
            i += 2
            continue
        if arg.startswith("--"):
            args.append(arg)
            i += 1
            continue
        positional.append(arg)
        i += 1

    if "--strict" not in args:
        print("vitexec failed: this environment only runs `vitexec --strict <script>`.", file=sys.stderr)
        return 1
    if len(positional) != 1:
        print("vitexec failed: pass exactly one script file.", file=sys.stderr)
        return 1
    script = resolve_script(positional[0])
    if script is None:
        print(f"vitexec failed: script file not found: {positional[0]} (checked as written and under ./vitexec)", file=sys.stderr)
        return 1

    run = modal.Cls.from_name("vitexec-harness", "Harness")().run
    exit_code = 0
    with HARNESS_LOG.open("a") as harness_log:
        harness_log.write(f"=== run {script} {args}\n")
        for event in run.remote_gen(script.read_text(), script.suffix, args):
            kind = event[0]
            if kind == "line":
                text = event[1]
                if text.startswith("[log] [harness]") or text.startswith("[harness"):
                    harness_log.write(text + "\n")
                    harness_log.flush()
                    continue
                print(text, flush=True)
            elif kind == "exit":
                exit_code = int(event[1])
            elif kind == "file":
                target = artifacts[event[1]]
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(base64.b64decode(event[2]))
    return exit_code


def resolve_script(value: str) -> Path | None:
    for candidate in (Path(value), Path("vitexec") / value):
        if candidate.is_file():
            return candidate
    return None


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
