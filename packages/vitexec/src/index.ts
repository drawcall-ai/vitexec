import { posix } from "node:path";
import { normalizePath, type Plugin } from "vite";

const VITEXEC_CODE_ROUTE = "/__vitexec/code";
const VITEXEC_MODULE_DIR = "/.vitexec/code";

export type VitexecModuleExtension = ".js" | ".jsx" | ".mjs" | ".mts" | ".ts" | ".tsx";

export type VitexecPluginOptions = {
  code: string;
  id: string;
  moduleExtension?: VitexecModuleExtension;
  /**
   * When true, the injected runtime only imports the snippet after the page sets
   * `globalThis.__vitexecArm === id`. Used when adopting an already-loaded page so
   * the snippet does not run on the page's pre-existing load (before vitexec has
   * exposed `__vitexecReport`). Fresh pages owned by vitexec leave this false and
   * run unconditionally — identical to the default behavior.
   */
  armed?: boolean;
};

function decodeId(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function codeRouteForBase(base: string): string {
  return new URL(`.${VITEXEC_CODE_ROUTE}`, baseUrl(base)).pathname;
}

function codeIdFromUrl(value: string, base = "/"): string | undefined {
  const pathname = pathnameFromUrl(value);
  const codeRoute = codeRouteForBase(base);
  const route = pathname.startsWith(`${codeRoute}/`)
    ? codeRoute
    : VITEXEC_CODE_ROUTE;
  if (!pathname.startsWith(`${route}/`)) return undefined;

  const encodedId = pathname.slice(route.length + 1);
  return decodeId(encodedId);
}

function pathnameFromUrl(value: string): string {
  return new URL(value, "http://vitexec.local").pathname;
}

function baseUrl(base: string): URL {
  const pathname = base.endsWith("/") ? base : `${base}/`;
  return new URL(pathname, "http://vitexec.local");
}

function virtualModuleId(id: string, extension: VitexecModuleExtension): string {
  return `${VITEXEC_MODULE_DIR}/${encodeURIComponent(id)}${extension}`;
}

function resolvedModuleId(root: string, id: string, extension: VitexecModuleExtension): string {
  return normalizePath(posix.join(normalizePath(root), virtualModuleId(id, extension)));
}

function idFromResolvedModuleId(
  root: string,
  id: string,
  extension: VitexecModuleExtension
): string | undefined {
  const prefix = `${normalizePath(root)}${VITEXEC_MODULE_DIR}/`;
  if (!id.startsWith(prefix) || !id.endsWith(extension)) return undefined;

  const encodedId = id.slice(prefix.length, -extension.length);
  return decodeId(encodedId);
}

function runtimeScript(id: string, base: string, armed: boolean): string {
  const run = `globalThis.__vitexecRuns[${JSON.stringify(id)}] = import(${JSON.stringify(codeRouteForBase(base))} + "/" + ${JSON.stringify(encodeURIComponent(id))})
  .catch(console.error)
  .finally(() => globalThis.__vitexecReport?.());`;

  if (!armed) {
    return `
globalThis.__vitexecRuns ??= {};
${run}
`;
  }

  return `
globalThis.__vitexecRuns ??= {};
if (globalThis.__vitexecArm === ${JSON.stringify(id)}) {
  ${run}
}
`;
}

export function vitexec(options: VitexecPluginOptions): Plugin {
  let isDevServer = false;
  let base = "/";
  let root = "";
  const moduleExtension = options.moduleExtension ?? ".js";

  return {
    name: "vitexec",
    apply: "serve",
    configResolved(config) {
      isDevServer = config.command === "serve";
      base = config.base;
      root = normalizePath(config.root);
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const codeId = request.url && codeIdFromUrl(request.url, base);
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
      const codeId = codeIdFromUrl(id, base);
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
            children: runtimeScript(options.id, base, options.armed ?? false),
            injectTo: "head"
          }
        ]
      };
    }
  };
}
