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
    async ready() {
      await Promise.race([
        new Promise<void>(resolve => {
          const check = () => { if (output.includes("[ready]")) { listeners.delete(check); resolve(); } };
          listeners.add(check); check();
        }),
        done.then(result => { throw new Error(`Owner exited before ready: ${result.output}`); })
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
  await owner.ready();
  return owner;
}

describe("session CLI", () => {
  it("opens without a script, preserves state and routes output to each command", async () => {
    const owner = await open();
    expect(owner.output()).toContain("app boot");
    expect((await launch(["run", "game", 'document.querySelector("main").textContent = "kept";']).done).code).toBe(0);
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
    const closed = await launch(["close", "game"]).done;
    expect(closed, `${closed.output}\nOwner: ${owner?.output()}`).toMatchObject({ code: 0 });
    expect((await owner.done).code).toBe(0);
    expect((await launch(["close", "game"]).done).code).toBe(0);
  });

  it("rejects duplicate sessions and exits nonzero on script errors", async () => {
    await open();
    expect((await launch(["open", "game"]).done).code).toBe(1);
    const failure = await launch(["run", "game", 'throw new Error("script failed")']).done;
    expect(failure.code).toBe(1);
    expect(failure.output).toContain("script failed");
    expect((await launch(["run", "game", 'console.log("recovered")']).done).code).toBe(0);
  });

  it("interrupts active runs on close", async () => {
    await open();
    const active = launch(["run", "game", 'await new Promise(() => {});']);
    // Closing is allowed whether this client was accepted yet or is still connecting.
    const closed = await launch(["close", "game"]).done;
    expect(closed, `${closed.output}\nOwner: ${owner?.output()}`).toMatchObject({ code: 0 });
    expect((await active.done).code).toBe(1);
  });

  it("cleans up on SIGTERM and allows the same session name again", async () => {
    const first = await open();
    first.child.kill("SIGTERM");
    expect((await first.done).code).toBe(0);
    owner = launch(["open", "game"]);
    await owner.ready();
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
  it("provides subcommand help and rejects options for the wrong lifecycle", async () => {
    expect((await launch(["open", "--help"]).done).output).toContain("Usage: vitexec open");
    expect((await launch(["run", "game", "", "--viewport", "100x100"]).done).code).toBe(1);
    expect((await launch(["open", "game", "--screenshot", "unused.png"]).done).code).toBe(1);
  });

});
