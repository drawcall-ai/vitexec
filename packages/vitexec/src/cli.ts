#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { openPage } from "./page.js";
import { run } from "./run.js";
import { callSession, openSession } from "./session.js";
import { addOptions, createRunOptions, type CliOptions } from "./cli/options.js";
import { resolveVitexecCodeInputDetails } from "./cli/code.js";

export { openBrowser, openBrowser as createBrowser, createBrowserArgs, createRemoteBrowserHeaders, ensureChromiumInstalled,
  VITEXEC_DEFAULT_REMOTE_EXPOSE_NETWORK, VITEXEC_LOCAL_GPU_BROWSER_ARGS,
  VITEXEC_REMOTE_GPU_BROWSER_ARGS } from "./browser.js";
export type { OpenBrowserOptions, OpenBrowserOptions as CreateBrowserOptions } from "./browser.js";
export { openServer, openServer as createServer } from "./app.js";
export type { OpenServerOptions, OpenServerOptions as CreateServerOptions } from "./app.js";
export { run, VITEXEC_TIMEOUT_MS } from "./run.js";
export type { AppRunOptions, PageRunOptions } from "./run.js";
export { openPage } from "./page.js";
export type { OpenPageOptions } from "./page.js";
export type { VitexecModuleExtension } from "./index.js";
export { runVitexec } from "./deprecated.js";
export type { RunVitexecOptions } from "./deprecated.js";
export { createRunOptions, VITEXEC_ENV } from "./cli/options.js";
export { resolveVitexecCodeInput, resolveVitexecCodeInputDetails } from "./cli/code.js";
export type { ResolvedVitexecCodeInput } from "./cli/code.js";

const print = (line: string) => { process.stdout.write(`${line}\n`); };

async function execute(parts: string[], options: CliOptions, session?: string) {
  if (!parts.length) throw new Error("Expected code or a script file.");
  const input = await resolveVitexecCodeInputDetails(parts);
  const settings = createRunOptions(options, { moduleExtension: input.moduleExtension });
  print("logs:");
  if (session) {
    for (const key of ["cpuProfilePath", "heapSnapshotPath", "performanceTracePath", "recordPath", "screenshotPath"] as const) {
      if (settings[key]) settings[key] = resolve(settings[key]);
    }
    await callSession(session, { code: input.code, options: settings }, print);
    return;
  }
  let hasLogs = false;
  const onLog = (line: string) => { hasLogs = true; print(line); };
  const page = await openPage({
    ...settings, gpu: settings.gpu ?? false,
    audio: Boolean(settings.recordPath) && settings.recordAudio !== false, onLog
  });
  try { await run(page, input.code, { ...settings, onLog }); }
  finally { await page.close(); }
  if (!hasLogs) print("(no browser logs captured)");
}

async function main() {
  const program = new Command().name("vitexec")
    .description("Execute scripts in a Vite app; use named sessions to preserve page state.")
    .enablePositionalOptions()
    .showHelpAfterError();
  addOptions(program, "once")
    .argument("[code-or-file...]", "literal code or a script file; automatically opens and closes the app")
    .action((parts: string[], options: CliOptions) => execute(parts, options));
  addOptions(program.command("open <session>"), "open")
    .description("Open an app without a script; stay in the foreground and stream page logs")
    .action((session: string, options: CliOptions) => openSession(session, { ...createRunOptions(options), onLog: print }));
  addOptions(program.command("run <session> <code-or-file...>"), "run")
    .description("Inject into a session's existing page and stream this script's logs")
    .action((session: string, parts: string[], options: CliOptions) => execute(parts, options, session));
  await program.parseAsync();
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(error => {
    console.error(`vitexec failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
