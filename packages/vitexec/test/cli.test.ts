import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { TestProject } from "./helpers.js";
import { createTempViteProject } from "./helpers.js";
import {
  resolveVitexecCodeInputDetails,
  resolveVitexecCodeInput,
  runVitexec,
  VITEXEC_TIMEOUT_MS
} from "../src/cli.js";

let currentProject: TestProject | undefined;
let currentTempDir: string | undefined;

afterEach(async () => {
  await currentProject?.close();
  if (currentTempDir) await rm(currentTempDir, { recursive: true, force: true });
  currentProject = undefined;
  currentTempDir = undefined;
});

describe("vitexec CLI runner", () => {
  it("returns browser logs for injected code", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>"
    });

    const output = await runVitexec("console.log('loaded')", {
      configFile: false,
      root: currentProject.root
    });

    expect(output).toContain("[log] loaded");
  });

  it("resolves a single file path to snippet code", async () => {
    currentTempDir = await mkdtemp(join(tmpdir(), "vitexec-code-"));
    const codePath = join(currentTempDir, "inspect.js");
    await writeFile(codePath, "console.log('from file')", "utf8");

    await expect(resolveVitexecCodeInput([codePath])).resolves.toBe(
      "console.log('from file')"
    );
  });

  it("preserves TypeScript snippet extensions", async () => {
    currentTempDir = await mkdtemp(join(tmpdir(), "vitexec-code-"));
    const codePath = join(currentTempDir, "inspect.ts");
    await writeFile(codePath, "const message: string = 'from ts'; console.log(message)", "utf8");

    await expect(resolveVitexecCodeInputDetails([codePath])).resolves.toEqual({
      code: "const message: string = 'from ts'; console.log(message)",
      moduleExtension: ".ts"
    });
  });

  it("keeps inline snippets as code when the input is not a file", async () => {
    await expect(
      resolveVitexecCodeInput(["console.log('inline')"])
    ).resolves.toBe("console.log('inline')");
    await expect(
      resolveVitexecCodeInput(["console.log", "('split')"])
    ).resolves.toBe("console.log ('split')");
  });

  it("keeps long inline snippets as code instead of treating them as paths", async () => {
    const code = `console.log(${JSON.stringify("x".repeat(1_000))})`;

    await expect(resolveVitexecCodeInput([code])).resolves.toBe(code);
  });

  it("can run injected code loaded from a file", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>",
      "inspect.js": "console.log('loaded from file')"
    });
    const code = await resolveVitexecCodeInput(
      ["inspect.js"],
      currentProject.root
    );

    const output = await runVitexec(code, {
      configFile: false,
      root: currentProject.root
    });

    expect(output).toContain("[log] loaded from file");
  });

  it("can run TypeScript code loaded from a file", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>",
      "inspect.ts": "const message: string = 'loaded from ts'; console.log(message)"
    });
    const input = await resolveVitexecCodeInputDetails(
      ["inspect.ts"],
      currentProject.root
    );

    const output = await runVitexec(input.code, {
      configFile: false,
      moduleExtension: input.moduleExtension,
      root: currentProject.root
    });

    expect(output).toContain("[log] loaded from ts");
  });

  it("captures runtime errors from injected code", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>"
    });

    const output = await runVitexec(
      "throw new Error('injected failure')",
      { configFile: false, root: currentProject.root }
    );

    expect(output).toContain("injected failure");
  });

  it("stops waiting immediately when injected code throws and returns the error logs", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>"
    });

    const startedAt = performance.now();
    const output = await runVitexec(
      `
        throw new Error("stop-on-error");
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      `,
      { configFile: false, root: currentProject.root, timeoutMs: 10_000 }
    );
    const durationMs = performance.now() - startedAt;

    expect(output).toContain("stop-on-error");
    expect(output).not.toContain("[error] timeout");
    expect(durationMs).toBeLessThan(3_000);
  });

  it("waits for async injected code to finish", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>"
    });

    const output = await runVitexec(
      "await new Promise((resolve) => setTimeout(resolve, 150)); console.log('async done')",
      { configFile: false, root: currentProject.root }
    );

    expect(output).toContain("[log] async done");
  });

  it("can run a richer imported TypeScript assertion against an example", async () => {
    const root = fileURLToPath(
      new URL("../../../examples/chrome-offline-game/", import.meta.url)
    );

    const output = await runVitexec(
      `
        import { OfflineRunnerGame } from "/src/game.ts";

        const canvas = document.createElement("canvas");
        canvas.style.width = "640px";
        canvas.style.height = "360px";
        document.body.append(canvas);

        const snapshots = [];
        const game = new OfflineRunnerGame(canvas, (snapshot) => snapshots.push(snapshot));
        game.togglePause();

        console.log("paused", game.getSnapshot().isPaused && snapshots.at(-1)?.isPaused);
      `,
      { configFile: false, root }
    );

    expect(output).toContain("[log] paused true");
  });

  it("loads the project Vite config by default", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>",
      "src/message.js": "export const message = 'configured alias';",
      "vite.config.ts": `
        import { fileURLToPath } from "node:url";
        import { defineConfig } from "vite";

        export default defineConfig({
          resolve: {
            alias: {
              "@app": fileURLToPath(new URL("./src", import.meta.url))
            }
          }
        });
      `
    });

    const output = await runVitexec(
      `
        import { message } from "@app/message.js";
        console.log(message);
      `,
      { root: currentProject.root }
    );

    expect(output).toContain("[log] configured alias");
  });

  it("can open projects served over HTTPS with a local certificate", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>secure</main>",
      "certs/localhost-key.pem": LOCALHOST_KEY,
      "certs/localhost-cert.pem": LOCALHOST_CERT,
      "vite.config.ts": `
        import { fileURLToPath } from "node:url";
        import { readFileSync } from "node:fs";
        import { defineConfig } from "vite";

        export default defineConfig({
          server: {
            https: {
              key: readFileSync(fileURLToPath(new URL("./certs/localhost-key.pem", import.meta.url))),
              cert: readFileSync(fileURLToPath(new URL("./certs/localhost-cert.pem", import.meta.url)))
            }
          }
        });
      `
    });

    const output = await runVitexec(
      "console.log(document.querySelector('main')?.textContent)",
      { root: currentProject.root }
    );

    expect(output).toContain("[log] secure");
  });

  it("loads injected code when the Vite project uses a custom base", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>base</main>",
      "vite.config.ts": `
        import { defineConfig } from "vite";

        export default defineConfig({
          base: "/xr/examples/minecraft/"
        });
      `
    });

    const output = await runVitexec(
      "console.log(document.querySelector('main')?.textContent)",
      { root: currentProject.root }
    );

    expect(output).toContain("[log] base");
    expect(output).not.toContain("[http 404]");
  });

  it("can load an explicit Vite config file", async () => {
    currentProject = await createTempViteProject({
      "custom.html": "<main>custom</main>",
      "src/message.js": "export const message = 'custom config';",
      "nested/vite.custom.ts": `
        import { fileURLToPath } from "node:url";
        import { defineConfig } from "vite";

        export default defineConfig({
          root: fileURLToPath(new URL("../", import.meta.url)),
          resolve: {
            alias: {
              "#src": fileURLToPath(new URL("../src", import.meta.url))
            }
          }
        });
      `
    });

    const output = await runVitexec(
      `
        import { message } from "#src/message.js";
        console.log(message);
      `,
      {
        configFile: join(currentProject.root, "nested", "vite.custom.ts"),
        path: "/custom.html"
      }
    );

    expect(output).toContain("[log] custom config");
  });

  it("opens the requested page path", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>home</main>",
      "cart/index.html": "<main id=\"route\">cart</main>"
    });

    const output = await runVitexec(
      "console.log(document.querySelector('#route')?.textContent)",
      { configFile: false, path: "cart/", root: currentProject.root }
    );

    expect(output).toContain("[log] cart");
  });

  it("can write a screenshot after injected code runs", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>"
    });
    currentTempDir = await mkdtemp(join(tmpdir(), "vitexec-shot-"));
    const screenshotPath = join(currentTempDir, "nested", "page.png");

    const output = await runVitexec(
      "document.body.style.background = 'rgb(255, 0, 0)'",
      { configFile: false, root: currentProject.root, screenshotPath }
    );

    expect(output).toContain(`[screenshot] ${screenshotPath}`);
    expect((await stat(screenshotPath)).size).toBeGreaterThan(0);
  });

  it("can record a browser video after injected code runs", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>"
    });
    currentTempDir = await mkdtemp(join(tmpdir(), "vitexec-record-"));
    const recordPath = join(currentTempDir, "nested", "page.webm");

    const output = await runVitexec(
      "document.body.textContent = 'recorded'; await new Promise((resolve) => setTimeout(resolve, 50))",
      { configFile: false, root: currentProject.root, recordPath }
    );

    expect(output).toContain(`[recording] ${recordPath}`);
    expect((await stat(recordPath)).size).toBeGreaterThan(0);
  });

  it("can launch with gpu-friendly new headless mode", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>"
    });

    const output = await runVitexec(
      "console.log('gpu mode')",
      { configFile: false, root: currentProject.root, gpu: true }
    );

    expect(output).toContain("[log] gpu mode");
  });

  it("reports failed resource loads with URL and status", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>"
    });

    const output = await runVitexec(
      "await fetch('/__vitexec/code/missing'); console.log('ready')",
      { configFile: false, root: currentProject.root }
    );

    expect(output).toContain("[http 404] GET");
    expect(output).toContain("/__vitexec/code/missing");
    expect(output).not.toContain("Failed to load resource");
  });

  it("uses a 10 minute timeout and logs timeout errors", async () => {
    expect(VITEXEC_TIMEOUT_MS).toBe(10 * 60 * 1000);

    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>"
    });

    const output = await runVitexec(
      "console.log('too slow')",
      { configFile: false, root: currentProject.root, timeoutMs: 1 }
    );

    expect(output).toContain("[error] timeout after 1ms");
  });
});

const LOCALHOST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCwhlLdX3a7cqgF
5Yv6CUvzna2zQrVkBXqRScdfDKg1os4MqTQGkK96lxL+sALPa/5lRvPu7AYCJUSg
54T2ApZg+9LhkPqgjLq2Wr0Xq20yMrpIKHzdlAOnt0BUpzHERD21cVNwYJ2rRkZM
dE6oPUE0nRCTuW5CNM2q1Tn3LAhmNypzhf4YdoI8Uck4u31Tem+EP9tjSD9R6Qm3
vgURjO318iGVuTGyCCt6RdoQdcFXtDPXq5+1UAx1sTbOYYUaXh9WexrrpcRQN2xn
1/0CB4FlccfXnNvHS3ZKEBqujNeYduqLqUbRwlSLjZdgt4HGyvJgjGkHjJ2hRbYZ
6dJpVUgPAgMBAAECggEACPzM6HyX2c3p6Y4ObgVlCp6noPpBVwERhIqDJw06iFZX
D+D2Md3SFdPuD9E4bvbIzPh5qtuDmbBBEPosN+fZtTK3wd28FBGJw2q5Y11mvkHS
JzCx3QillXBhddUGgLFCxCqrp2EGlgs0+dkzqgWDCxqO+nPN9uzcikPxDdzhkF+G
Ly+ZIjWN8U6zSH7uyCxKMTWhVwqZbGCclEiyH+lWa2dUk72LpkMxXCMgQv0yUeFH
96cYDeRFsBuQpcY5zYV4vDyzV14T7rW5r67wNuwEaee+xP37VqKD1GFTL5lgHJF8
tpSCUVi0PjDw28xcUROubYK1/sb/rP+FXO5UzwkwZQKBgQDkB7QS8gIy3C9WEwzj
77VEkhQRoOx0NPbgpgsQWvexiN7l+L7D4GVLQxT7pPUaLK3FfzvOfNY5Dwl4153l
0ze/+Xn1/hqUjL4/MUHNs8/a2qTfUVdoeY6wkrTf/vXeEucHB6QZTU7fNqa0iNtY
znoLPK0qmsdalCXrP29TSy78cwKBgQDGLVEYSCNOOPYWyNCWR1Sl8s1+NGf9m0DU
UhYIRxIHYCh7aR8u2WA97ogvrCglxCrSXtWHzqn60vIsMigdEfxuyirxdZLg3fS2
FXEUmq2762KvokxUfI/VQICLj5voN3ohFY6+cYu/K/yH2pemuN35FSXYPZhzi0he
H//SLN4a9QKBgE+RMJB7ybCdjBboxtKyTfoDTuVn1Zom8Q4qYinu1AcqzzxHs6j9
n9rHKYc1ZCEh/fCwGNpQTR/T02ZLNll/fjCKiLgBVp0HD0tVkLSKTbj8GhOienGG
GPgb+OlAOeKnjd2yGNyLUT4p/7l3F7LBOWy6W2JGZ9F/aEvR8rKJxXdpAoGBAIaj
kR3rHLlvL5oJMtV2fscD76KXnjMJgID/h+J1zoTeSoKVx86/doh8/19MGjaWUPV9
4pqSyJ8VI9zs8p3Vc2gdyBEl7PUDNtdiN+JkuDYc1H44yJz5x4p9eRfYKHcbAclq
aQFwCR6HltkBpNhrbrtkJ8MDDgkqDq+ME/TJ8NflAoGALTZV2s9mx7rQoOhU/JqB
JcAycHPhcDXSIc0YSMFAvtzCs4hC8j4sORacmdPLyEf1hTJlsk3HItAt2VXh57I2
pOTYGWdB02kwradfEeHnRE2tvoNMCRqIGOj7IaTY7WbkqSLFjQZzPD8fo1wlr80M
EzmM9UCtwZFemEKMGjGIZ3M=
-----END PRIVATE KEY-----
`;

const LOCALHOST_CERT = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUEUXtZCHbyIvwAFBmiCsP8jtYVZYwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDQzMDAyMTI0MloXDTM2MDQy
NzAyMTI0MlowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAsIZS3V92u3KoBeWL+glL852ts0K1ZAV6kUnHXwyoNaLO
DKk0BpCvepcS/rACz2v+ZUbz7uwGAiVEoOeE9gKWYPvS4ZD6oIy6tlq9F6ttMjK6
SCh83ZQDp7dAVKcxxEQ9tXFTcGCdq0ZGTHROqD1BNJ0Qk7luQjTNqtU59ywIZjcq
c4X+GHaCPFHJOLt9U3pvhD/bY0g/UekJt74FEYzt9fIhlbkxsggrekXaEHXBV7Qz
16uftVAMdbE2zmGFGl4fVnsa66XEUDdsZ9f9AgeBZXHH15zbx0t2ShAarozXmHbq
i6lG0cJUi42XYLeBxsryYIxpB4ydoUW2GenSaVVIDwIDAQABo28wbTAdBgNVHQ4E
FgQUC7VnONTsrcbGFoKtUY5AXlByfz0wHwYDVR0jBBgwFoAUC7VnONTsrcbGFoKt
UY5AXlByfz0wDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SH
BH8AAAEwDQYJKoZIhvcNAQELBQADggEBAACWGeLNgSg9gTIEcMgrNEXaIqzuaSXQ
bQVT4Fsvqj/i7WG7fN/yNEzUsjb3EPPSoX7VLuNdwc/rV7L124ScxWV9iJN5/ct4
fnzv9yY4EoFM4S7ggxYFrqptY022YG6L15MUXxOGyHCWp9IahY2HUpCy4rAe9tQn
CmJW8Z3gVpW1pUKofN7hdFmtHtyMQw4+HfYFhA+tzKLHXIZp/p/qwVN7BSrmOIfB
HzkgeFWJXjN/Ob3qPjeKzoe3AbTC7qvKk0u7V7a2AEdsT6sZdu46Ukjnk8tO+gP3
dgvPmRq+ycWNbvncU5hNWSODF/1ufPr619lK8bYx0+bDQWnDynEr7Jg=
-----END CERTIFICATE-----
`;
