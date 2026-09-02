"""Remote vitexec strict-mode harness: a T4 box holding the pristine battle
royale template (vitexec scripts removed, hit/shot instrumentation added) and
the locally built vitexec package. `run` executes one strict script and
streams the vitexec output lines back."""
import base64
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import modal

HERE = Path(__file__).parent
TEMPLATE = Path(os.environ.get("TEMPLATE", HERE / "template"))  # pristine market template
VITEXEC_TGZ = Path(os.environ.get("VITEXEC_TGZ", HERE / "vitexec.tgz"))  # from `pnpm pack`
# EGL-backed ANGLE only: Vulkan/WebGPU init in the GPU process stalls this box.
BROWSER_ARGS = '["--enable-gpu","--ignore-gpu-blocklist","--use-gl=angle","--use-angle=gl-egl","--disable-features=Vulkan","--no-sandbox"]'

image = (
    modal.Image.from_registry("nvidia/cuda:12.4.1-runtime-ubuntu22.04", add_python="3.11")
    .apt_install("curl", "libegl1", "libgl1", "libgles2", "libvulkan1", "ca-certificates", "gnupg")
    .run_commands(
        "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -",
        "apt-get install -y nodejs",
        "npx -y playwright@1.52.0 install-deps chromium",
    )
    .env({
        "NVIDIA_DRIVER_CAPABILITIES": "all",
        "PLAYWRIGHT_BROWSERS_PATH": "/root/.cache/ms-playwright",
        "VITEXEC_BROWSER_ARGS": BROWSER_ARGS,
    })
    .add_local_dir(TEMPLATE, "/work/template", copy=True, ignore=["node_modules", "vitexec", "dist", ".git"])
    .add_local_file(VITEXEC_TGZ, "/work/vitexec.tgz", copy=True)
    .add_local_file(HERE / "accuracy.ts", "/work/template/harness/accuracy.ts", copy=True)
    .workdir("/work/template")
    .run_commands(
        "npm ci --no-audit --no-fund",
        "npm i --no-audit --no-fund --no-save /work/vitexec.tgz",
        # the instrumentation loads after the app's own entry module
        """sed -i 's#<script type="module" src="/src/main.ts"></script>#<script type="module" src="/src/main.ts"></script>\\n    <script type="module" src="/harness/accuracy.ts"></script>#' index.html""",
        "grep -q harness/accuracy.ts index.html",
        # pre-bundle deps: a first-load optimizer pass with HMR off leaves the page stuck
        "npx vite optimize",
        "test -f node_modules/.vite/deps/_metadata.json",
        "cp -r node_modules/.vite /work/vite-cache",
        # the Chromium build matching the playwright version vitexec resolves to
        "npx playwright install chromium",
    )
)

app = modal.App("vitexec-harness", image=image)

ARTIFACT_FLAGS = {"--screenshot", "--record"}


# a real CPU reservation: with the 0.125-core default the page starves under cold Vite transforms + Chromium
@app.cls(gpu="T4", cpu=4.0, memory=16384, timeout=1200, min_containers=1, scaledown_window=1800)
@modal.concurrent(max_inputs=4)
class Harness:
    @modal.enter()
    def warm_up(self):
        """Modal images are fetched lazily: the first reads of the game's assets stall a boot.
        Touch every file the app serves and boot it once before serving runs."""
        started = time.monotonic()
        subprocess.run(
            "find /work/template/public /work/template/src /work/template/node_modules/.vite /work/template/index.html -type f -print0 | xargs -0 cat > /dev/null",
            shell=True, check=True,
        )
        Path("/tmp/warmup.ts").write_text(
            'import { observe, sleep } from "vitexec/strict";\n'
            'const t0 = performance.now();\n'
            'while (!(await observe(() => Boolean((window as any).LASTDROP)))) { if (performance.now() - t0 > 90000) throw new Error("warm-up boot failed"); await sleep(1000); }\n'
            'console.log("warm-up booted", Math.round(performance.now() - t0), "ms");\n'
        )
        result = subprocess.run(
            ["npx", "vitexec", "--strict", "--timeout", "100", "/tmp/warmup.ts"],
            cwd="/work/template", capture_output=True, text=True, env=os.environ,
        )
        print(f"warm-up took {time.monotonic() - started:.1f}s:", [l for l in result.stdout.splitlines() if "warm-up" in l or "[error]" in l], flush=True)

    @modal.method()
    def exec(self, script: str):
        """Run a Node ESM script inside the template tree and yield its output lines."""
        path = Path("/work/template/harness/exec.mjs")
        path.write_text(script)
        process = subprocess.Popen(
            ["node", str(path)], cwd="/work/template", stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=os.environ
        )
        assert process.stdout
        for line in process.stdout:
            yield line.rstrip("\n")
        process.wait()
        yield f"[exit {process.returncode}]"

    @modal.method()
    def run(self, script: str, extension: str, args: list[str]):
        """Yield ("line", text) per vitexec output line, ("exit", code), then ("file", flag, base64) per artifact."""
        work = Path(tempfile.mkdtemp(prefix="run-"))
        script_path = work / f"script{extension}"
        script_path.write_text(script)
        forwarded: list[str] = []
        artifacts: dict[str, Path] = {}
        i = 0
        while i < len(args):
            arg = args[i]
            if arg in ARTIFACT_FLAGS:
                suffix = ".png" if arg == "--screenshot" else ".webm"
                artifacts[arg] = work / f"artifact{suffix}"
                forwarded += [arg, str(artifacts[arg])]
                i += 2
                continue
            forwarded.append(arg)
            i += 1
        started = time.monotonic()
        while time.monotonic() - started < 30:
            leftover = subprocess.run(["pgrep", "-fc", "chrom"], capture_output=True, text=True).stdout.strip()
            if leftover == "0":
                break
            time.sleep(0.5)
        yield ("line", f"[harness-wait] {time.monotonic() - started:.1f}s for chrome processes to exit (last count {leftover})")
        # every run starts from the image's pre-bundled cache; a run that re-bundles poisons the next
        subprocess.run("rm -rf /work/template/node_modules/.vite && cp -r /work/vite-cache /work/template/node_modules/.vite", shell=True, check=True)
        cache = Path("/work/template/node_modules/.vite")
        state = sorted(f"{p.relative_to(cache)}@{int(p.stat().st_mtime)}" for p in cache.rglob("*") if p.is_dir()) if cache.exists() else []
        yield ("line", f"[harness-cache] {state} task {os.environ.get('MODAL_TASK_ID')} load {open('/proc/loadavg').read().split()[:3]}")
        command = ["npx", "vitexec", *forwarded, str(script_path)]
        process = subprocess.Popen(
            command,
            cwd="/work/template",
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            env=os.environ,
        )
        assert process.stdout
        for line in process.stdout:
            yield ("line", line.rstrip("\n"))
        process.wait()
        yield ("exit", str(process.returncode))
        for flag, path in artifacts.items():
            if path.exists():
                yield ("file", flag, base64.b64encode(path.read_bytes()).decode())
