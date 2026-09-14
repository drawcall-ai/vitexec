import { dirname, resolve } from "node:path";
import { createServer as createViteServer, loadConfigFromFile, type ViteDevServer } from "vite";
import { vitexec, type VitexecPluginOptions } from "./index.js";
import type { AppRunOptions } from "./run.js";

export type CreateServerOptions = {
  root?: string;
  configFile?: string | false;
};

/** Create a Vite server with injection enabled, already listening on a local port. */
export async function createServer(options: CreateServerOptions = {}) {
  const server = await startServer(options);
  return { url: appUrl(server), close: () => server.close() };
}

export function startApp(id: string, code: string, options: AppRunOptions): Promise<ViteDevServer> {
  return startServer(options, {
    [normalizePagePath(options.path ?? "/")]: {
      code, completionMessage: id, id, moduleExtension: options.moduleExtension
    }
  });
}

async function startServer(
  options: CreateServerOptions,
  pages?: VitexecPluginOptions["pages"]
): Promise<ViteDevServer> {
  const root = await resolveViteRootOption(options);
  const server = await createViteServer({
    configFile: options.configFile,
    root,
    logLevel: "silent",
    server: {
      hmr: false,
      host: "127.0.0.1",
      open: false,
      port: 0,
      strictPort: false,
      watch: null
    },
    plugins: [vitexec({ directory: false, pages })]
  });

  try {
    await server.listen();
    return server;
  } catch (error) {
    await server.close();
    throw error;
  }
}

async function resolveViteRootOption(options: CreateServerOptions): Promise<string | undefined> {
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

export function appUrl(server: ViteDevServer, path?: string): string {
  const base = server.resolvedUrls?.local[0];
  if (base) {
    return path === undefined ? base : new URL(normalizePagePath(path), base).toString();
  }

  const address = server.httpServer?.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start Vite server.");
  }

  const url = `http://127.0.0.1:${address.port}/`;
  return new URL(path === undefined ? server.config.base : normalizePagePath(path), url).toString();
}

function normalizePagePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

