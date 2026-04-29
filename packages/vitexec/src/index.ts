import { posix } from "node:path";
import { normalizePath, type Plugin } from "vite";

const VITEXEC_CODE_ROUTE = "/__vitexec/code";
const VITEXEC_MODULE_DIR = "/.vitexec/code";

export type VitexecPluginOptions = {
  code: string;
  id: string;
  moduleExtension?: string;
};

function decodeId(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function codeIdFromUrl(value: string): string | undefined {
  const pathname = value.split("?")[0] ?? value;
  if (!pathname.startsWith(`${VITEXEC_CODE_ROUTE}/`)) return undefined;

  const encodedId = pathname.slice(VITEXEC_CODE_ROUTE.length + 1);
  return decodeId(encodedId);
}

function virtualModuleId(id: string, extension: string): string {
  return `${VITEXEC_MODULE_DIR}/${encodeURIComponent(id)}${extension}`;
}

function resolvedModuleId(root: string, id: string, extension: string): string {
  return normalizePath(posix.join(normalizePath(root), virtualModuleId(id, extension)));
}

function idFromResolvedModuleId(root: string, id: string, extension: string): string | undefined {
  const prefix = `${normalizePath(root)}${VITEXEC_MODULE_DIR}/`;
  if (!id.startsWith(prefix) || !id.endsWith(extension)) return undefined;

  const encodedId = id.slice(prefix.length, -extension.length);
  return decodeId(encodedId);
}

function runtimeScript(id: string): string {
  return `
globalThis.__vitexecRuns ??= {};
globalThis.__vitexecRuns[${JSON.stringify(id)}] = import(${JSON.stringify(VITEXEC_CODE_ROUTE)} + "/" + ${JSON.stringify(encodeURIComponent(id))}).catch(console.error);
`;
}

export function vitexec(options: VitexecPluginOptions): Plugin {
  let isDevServer = false;
  let root = "";
  const moduleExtension = options.moduleExtension ?? ".js";

  return {
    name: "vitexec",
    apply: "serve",
    configResolved(config) {
      isDevServer = config.command === "serve";
      root = normalizePath(config.root);
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const codeId = request.url && codeIdFromUrl(request.url);
        if (!codeId) return next();
        if (request.method !== "GET") {
          response.statusCode = 405;
          response.setHeader("content-type", "text/plain; charset=utf-8");
          response.end("Use GET to load code.");
          return;
        }
        if (codeId !== options.id) {
          response.statusCode = 404;
          response.setHeader("content-type", "text/plain; charset=utf-8");
          response.end(`No vitexec code found for id "${codeId}".`);
          return;
        }
        return next();
      });
    },
    resolveId(id) {
      const codeId = codeIdFromUrl(id);
      if (codeId === options.id) return resolvedModuleId(root, codeId, moduleExtension);

      return undefined;
    },
    load(id) {
      const codeId = idFromResolvedModuleId(root, id, moduleExtension);
      if (codeId !== options.id) return undefined;

      return options.code;
    },
    transformIndexHtml(html) {
      if (!isDevServer) return html;

      return {
        html,
        tags: [
          {
            tag: "script",
            attrs: {
              type: "module"
            },
            children: runtimeScript(options.id),
            injectTo: "head"
          }
        ]
      };
    }
  };
}
