import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { dirname, resolve } from "node:path";
import { createServer as createViteServer, loadConfigFromFile } from "vite";
import { vitexec } from "./index.js";

export type OpenServerOptions = {
  root?: string;
  configFile?: string | false;
};

/** Create a Vite server with injection enabled, already listening on a local port. */
export async function openServer(options: OpenServerOptions = {}) {
  // Middleware mode leaves process signals and shutdown to the session owner.
  let parent: Server | undefined;
  const root = await resolveViteRootOption(options);
  const vite = await createViteServer({
    configFile: options.configFile,
    root,
    logLevel: "silent",
    server: {
      middlewareMode: true,
      hmr: false,
      host: "127.0.0.1",
      open: false,
      port: 0,
      strictPort: false,
      watch: null
    },
    plugins: [vitexec({ directory: false }), {
      name: "vitexec-server",
      configResolved(config) {
        // Keep Vite's client transport on the owned port; file watching stays disabled.
        parent = config.server.https ? createHttpsServer(config.server.https) : createHttpServer();
        config.server.hmr = { server: parent };
      }
    }]
  });
  if (!parent) throw new Error("Vite did not configure its HTTP server.");
  const server = parent;
  server.on("request", vite.middlewares);
  const https = vite.config.server.https;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    server.closeAllConnections();
    const results = await Promise.allSettled([
      vite.close(),
      new Promise<void>((resolve, reject) => {
        if (!server.listening) { resolve(); return; }
        server.close(error => error ? reject(error) : resolve());
      })
    ]);
    const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Failed to close Vite server.");
  })();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Vite server has no TCP address.");
    return { url: `${https ? "https" : "http"}://127.0.0.1:${address.port}${vite.config.base}`, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function resolveViteRootOption(options: OpenServerOptions): Promise<string | undefined> {
  if (options.root || !options.configFile) return options.root;
  const configFile = resolve(options.configFile);
  const configRoot = dirname(configFile);
  const loadedConfig = await loadConfigFromFile(
    { command: "serve", mode: "development", isSsrBuild: false, isPreview: false },
    configFile,
    configRoot,
    "silent"
  );
  if (loadedConfig?.config.root !== undefined) return undefined;

  return configRoot;
}

