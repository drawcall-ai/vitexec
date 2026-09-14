import { setTimeout as delay } from "node:timers/promises";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createTempViteProject, type TestProject } from "./helpers.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
let project: TestProject | undefined;
let owner: ReturnType<typeof launch> | undefined;
function launch(args: string[]) {
  const child = spawn(process.execPath, [cli, ...args], { cwd: project?.root, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const listeners = new Set<() => void>();
  child.stdout.on("data", data => { output += data; for (const notify of listeners) notify(); });
  child.stderr.on("data", data => { output += data; for (const notify of listeners) notify(); });
  const done = new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", code => resolve({ code, output }));
  });
  return {
    child, done,
    output: () => output,
    async waitFor(text: string) {
      await Promise.race([
        new Promise<void>(resolve => {
          const check = () => { if (output.includes(text)) { listeners.delete(check); resolve(); } };
          listeners.add(check); check();
        }),
        done.then(result => { throw new Error(`Process exited before expected output: ${result.output}`); })
      ]);
    }
  };
}
afterEach(async () => {
  if (owner?.child.exitCode === null) { owner.child.kill("SIGTERM"); await owner.done; }
  await project?.close();
  owner = undefined;
  project = undefined;
});
async function open() {
  project = await createTempViteProject({ "index.html": '<script>console.log("app boot")</script><main>0</main>' });
  owner = launch(["open", "game"]);

  return owner;
}

describe("session CLI", () => {
  it("opens without a script, preserves state and routes output to each command", async () => {
    const owner = await open();
    expect((await launch(["run", "game", 'document.querySelector("main").textContent = "kept";']).done).code).toBe(0);
    expect(owner.output()).toContain("app boot");
    expect(owner.output()).not.toContain("[ready]");
    const [a, b] = await Promise.all([
      launch(["run", "game", 'console.log("first", document.querySelector("main").textContent); await new Promise(r => setTimeout(r, 50)); console.log("first done");']).done,
      launch(["run", "game", 'console.log("second");']).done
    ]);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(a.output).toContain("first kept");
    expect(a.output).not.toContain("second");
    expect(b.output).not.toContain("first");
    expect(owner.output()).not.toContain("first kept");
    owner.child.kill("SIGTERM");
    expect((await owner.done).code).toBe(0);
  });

  it("rejects duplicate sessions and exits nonzero on script errors", async () => {
    await open();
    expect((await launch(["run", "game", ""]).done).code).toBe(0);
    expect((await launch(["open", "game"]).done).code).toBe(1);
    const failure = await launch(["run", "game", 'throw new Error("script failed")']).done;
    expect(failure.code).toBe(1);
    expect(failure.output).toContain("script failed");
    expect((await launch(["run", "game", 'console.log("recovered")']).done).code).toBe(0);
  });

  it.each(["SIGINT", "SIGTERM"] as const)("interrupts active runs on %s", async signal => {
    const owner = await open();
    const active = launch(["run", "game", 'console.log("running"); await new Promise(() => {});']);
    await active.waitFor("[log] running");
    owner.child.kill(signal);
    expect((await owner.done).code).toBe(0);
    expect((await active.done).code).toBe(1);
  });

  it("cleans up on SIGTERM and allows the same session name again", async () => {
    const first = await open();
    expect((await launch(["run", "game", ""]).done).code).toBe(0);
    first.child.kill("SIGTERM");
    expect((await first.done).code).toBe(0);
    owner = launch(["open", "game"]);
    expect((await launch(["run", "game", ""]).done).code).toBe(0);
  });

  it("waits for a session launched just after its client", async () => {
    project = await createTempViteProject({ "index.html": "<main>loaded</main>" });
    const client = launch(["run", "game", 'console.log(document.querySelector("main").textContent)']);
    await delay(200);
    owner = launch(["open", "game"]);
    const result = await client.done;
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("[log] loaded");
  });

  it("reports startup failures to waiting clients", async () => {
    project = await createTempViteProject({
      "index.html": "<main/>",
      "vite.config.mjs": 'export default async () => { await new Promise(r => setTimeout(r, 800)); throw new Error("startup failed"); };'
    });
    owner = launch(["open", "game"]);
    const client = await launch(["run", "game", 'console.log("should not run")']).done;
    expect(client.code).toBe(1);
    expect((await owner.done).code).toBe(1);
    expect(client.output).toContain("startup failed");
  });

  it("does not inject timed-out work after startup completes", async () => {
    project = await createTempViteProject({
      "index.html": "<main>untouched</main>",
      "vite.config.mjs": 'export default async () => { await new Promise(r => setTimeout(r, 800)); return {}; };'
    });
    owner = launch(["open", "game"]);
    const expired = await launch(["run", "game", 'document.querySelector("main").textContent = "changed"', "--timeout", "0.2"]).done;
    expect(expired.code).toBe(1);
    expect(expired.output).toContain("timed out");
    const next = await launch(["run", "game", 'console.log(document.querySelector("main").textContent)']).done;
    expect(next.code, next.output).toBe(0);
    expect(next.output).toContain("[log] untouched");
  });

  it("interrupts navigation on SIGTERM", async () => {
    project = await createTempViteProject({
      "index.html": '<script>console.log("navigating")</script><script src="/hang.js"></script>',
      "vite.config.mjs": 'export default { plugins: [{ name: "hang", configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url !== "/hang.js") next(); }); } }] };'
    });
    owner = launch(["open", "game"]);
    await owner.waitFor("[log] navigating");
    const client = launch(["run", "game", 'console.log("never")']);
    owner.child.kill("SIGTERM");
    expect((await owner.done).code).toBe(0);
    expect((await client.done).code).toBe(1);
  });

  it("bounds the wait for an absent session", async () => {
    project = await createTempViteProject({ "index.html": "<main/>" });
    expect((await launch(["run", "missing", ""]).done).code).toBe(1);
  });

  it("keeps one-shot execution and reports its failures", async () => {
    project = await createTempViteProject({ "index.html": "<main>ready</main>" });
    const success = await launch(['console.log(document.querySelector("main").textContent)']).done;
    expect(success.code).toBe(0);
    expect(success.output).toContain("[log] ready");
    const failure = await launch(['throw new Error("one shot failed")']).done;
    expect(failure.code).toBe(1);
    expect(failure.output).toContain("one shot failed");
  });
  it("keeps one-shot TypeScript files, flags, logs, and artifacts", async () => {
    project = await createTempViteProject({
      "index.html": "<main>wrong page</main>",
      "inspect.html": '<script>console.log("page boot")</script><main>selected</main>',
      "vitexec/check.ts": 'const label: string = "script"; console.log(label, document.querySelector("main").textContent, innerWidth);'
    });
    const result = await launch([
      "check.ts", "--path", "/inspect.html", "--viewport", "390x844",
      "--screenshot", "capture.png", "--network-trace", "network.har"
    ]).done;
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("logs:");
    expect(result.output).toContain("[log] page boot");
    expect(result.output).toContain("[log] script selected 390");
    expect(result.output).toContain("[screenshot] capture.png");
    expect(result.output).toContain("[network-trace] network.har");
    expect((await stat(join(project.root, "capture.png"))).size).toBeGreaterThan(0);
    expect(await readFile(join(project.root, "network.har"), "utf8")).toContain("inspect.html");
  });

  it("keeps one-shot empty output and streams logs before completion", async () => {
    project = await createTempViteProject({ "index.html": "<main/>" });
    expect(await launch(["void 0"]).done).toEqual({
      code: 0, output: "logs:\n(no browser logs captured)\n"
    });
    const active = launch(['console.log("first"); await new Promise(r => setTimeout(r, 300)); console.log("last");']);
    await active.waitFor("[log] first");
    expect(active.child.exitCode).toBeNull();
    const result = await active.done;
    expect(result.code).toBe(0);
    expect(result.output).toContain("[log] last");
  });

  it("exits and cleans up when a one-shot script times out", async () => {
    project = await createTempViteProject({ "index.html": "<main/>" });
    const result = await launch(["await new Promise(() => {})", "--timeout", "1"]).done;
    expect(result.code).toBe(1);
    expect(result.output).toContain("timed out");
  });

  it("provides subcommand help and rejects options for the wrong lifecycle", async () => {
    expect((await launch(["open", "--help"]).done).output).toContain("--headed");
    expect((await launch(["--help"]).done).output).toContain("--headed");
    expect((await launch(["run", "game", "", "--headed"]).done).code).toBe(1);
    expect((await launch(["run", "game", "", "--viewport", "100x100"]).done).code).toBe(1);
    expect((await launch(["open", "game", "--screenshot", "unused.png"]).done).code).toBe(1);
  });

});
