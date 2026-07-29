import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, posix, resolve } from "node:path";
import {
  normalizePath,
  type IndexHtmlTransformContext,
  type Plugin,
  type ResolvedConfig
} from "vite";

const VITEXEC_CODE_ROUTE = "/__vitexec/code";
const VITEXEC_MODULE_DIR = "/.vitexec/code";
const MODULE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);

export type VitexecModuleExtension = ".js" | ".jsx" | ".mjs" | ".mts" | ".ts" | ".tsx";

export type VitexecInlineModule = {
  code: string;
  completionMessage?: string;
  id: string;
  moduleExtension?: VitexecModuleExtension;
};

export type VitexecPluginOptions = {
  directory?: string | false;
  pages?: Record<string, string | VitexecInlineModule>;
};

type FileModule = {
  file: string;
  id: string;
  kind: "file";
};

type InlineModule = VitexecInlineModule & {
  kind: "inline";
};

type PageModule = FileModule | InlineModule;

type PluginState = {
  config: ResolvedConfig;
  directories: Set<string>;
  pages: Map<string, PageModule>;
};

const states = new WeakMap<ResolvedConfig, PluginState>();

function pathnameFromUrl(value: string): string {
  return new URL(value, "http://vitexec.local").pathname;
}

function basePath(base: string): string {
  return pathnameFromUrl(base.endsWith("/") ? base : `${base}/`);
}

function pagePath(value: string, base = "/"): string {
  const pathname = pathnameFromUrl(value);
  const prefix = basePath(base);
  const page =
    prefix !== "/" && pathname.startsWith(prefix)
      ? `/${pathname.slice(prefix.length)}`
      : pathname;

  return page.endsWith("/index.html")
    ? page.slice(0, -"index.html".length)
    : page;
}

function codeRouteForBase(base: string): string {
  return new URL(`.${VITEXEC_CODE_ROUTE}`, `http://vitexec.local${basePath(base)}`).pathname;
}

function codeIdFromUrl(value: string, base = "/"): string | undefined {
  const pathname = pathnameFromUrl(value);
  const route = codeRouteForBase(base);
  const prefix = pathname.startsWith(`${route}/`) ? route : VITEXEC_CODE_ROUTE;
  if (!pathname.startsWith(`${prefix}/`)) return undefined;

  try {
    return decodeURIComponent(pathname.slice(prefix.length + 1));
  } catch {
    return undefined;
  }
}

function moduleUrl(id: string, base: string): string {
  return `${codeRouteForBase(base)}/${encodeURIComponent(id)}`;
}

function resolvedModuleId(root: string, source: InlineModule): string {
  const extension = source.moduleExtension ?? ".js";
  return normalizePath(
    posix.join(
      normalizePath(root),
      VITEXEC_MODULE_DIR,
      `${encodeURIComponent(source.id)}${extension}`
    )
  );
}

function runtimeScript(source: PageModule, base: string): string {
  const completion = source.kind === "inline" && source.completionMessage
    ? `.finally(console.debug.bind(console, ${JSON.stringify(source.completionMessage)}))`
    : "";

  return `
import(${JSON.stringify(moduleUrl(source.id, base))})
  .catch(console.error.bind(console))${completion};
`;
}

function projectPath(root: string, path: string): string {
  return resolve(root, path.replace(/^[/\\]+/, ""));
}

function fileModule(file: string): FileModule {
  const normalizedFile = normalizePath(file);
  return {
    file: normalizedFile,
    id: `file:${normalizedFile}`,
    kind: "file"
  };
}

function inlineModule(source: VitexecInlineModule): InlineModule {
  return {
    ...source,
    kind: "inline"
  };
}

function sameModule(left: PageModule, right: PageModule): boolean {
  if (left.kind === "file" && right.kind === "file") return left.file === right.file;
  if (left.kind !== "inline" || right.kind !== "inline") return false;

  return (
    left.id === right.id &&
    left.code === right.code &&
    left.completionMessage === right.completionMessage &&
    left.moduleExtension === right.moduleExtension
  );
}

function addPage(pages: Map<string, PageModule>, page: string, source: PageModule): void {
  const normalizedPage = pagePath(page);
  const existing = pages.get(normalizedPage);
  if (!existing) {
    pages.set(normalizedPage, source);
    return;
  }
  if (sameModule(existing, source)) return;

  throw new Error(`Conflicting vitexec scripts for "${normalizedPage}".`);
}

function addOptions(state: PluginState, options: VitexecPluginOptions): void {
  const { root } = state.config;
  const directory = options.directory === undefined ? "vitexec" : options.directory;
  if (directory !== false) state.directories.add(projectPath(root, directory));

  for (const [page, source] of Object.entries(options.pages ?? {})) {
    addPage(
      state.pages,
      page,
      typeof source === "string"
        ? fileModule(projectPath(root, source))
        : inlineModule(source)
    );
  }
}

function isMissingPath(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

async function directoryEntries(directory: string): Promise<Dirent[]> {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingPath(error)) return [];
    throw error;
  }
}

async function discoveredPages(directory: string): Promise<Map<string, PageModule>> {
  const pages = new Map<string, PageModule>();
  for (const entry of await directoryEntries(directory)) {
    const extension = extname(entry.name);
    if (!entry.isFile() || !MODULE_EXTENSIONS.has(extension)) continue;

    const name = entry.name.slice(0, -extension.length);
    addPage(pages, `/${name}.html`, fileModule(resolve(directory, entry.name)));
  }
  return pages;
}

async function allPages(state: PluginState): Promise<Map<string, PageModule>> {
  const pages = new Map(state.pages);
  for (const directory of [...state.directories].sort()) {
    for (const [page, source] of await discoveredPages(directory)) {
      addPage(pages, page, source);
    }
  }
  return pages;
}

async function moduleById(state: PluginState, id: string): Promise<PageModule | undefined> {
  for (const source of (await allPages(state)).values()) {
    if (source.id === id) return source;
  }
  return undefined;
}

async function isHtmlFile(root: string, page: string): Promise<boolean> {
  const path = page.endsWith("/")
    ? resolve(root, page.slice(1), "index.html")
    : resolve(root, page.slice(1));

  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
}

function htmlWithScript(html: string, source: string): string {
  const tag = `  <script type="module" crossorigin src="${source}"></script>\n`;
  const bodyEnd = html.lastIndexOf("</body>");
  if (bodyEnd < 0) return `${html}\n${tag}`;
  return `${html.slice(0, bodyEnd)}${tag}${html.slice(bodyEnd)}`;
}

function builtModuleUrl(base: string, fileName: string): string {
  return base === "" || base === "./" ? `./${fileName}` : `${base}${fileName}`;
}

function builtPageFileName(page: string): string {
  if (page === "/") return "index.html";
  if (!page.endsWith(".html")) {
    throw new Error(`Vitexec build page "${page}" must end in ".html".`);
  }
  return page.slice(1);
}

function builtChunkName(page: string): string {
  const name = page.replace(/^\/|\.html$/g, "").replace(/[^a-zA-Z0-9]+/g, "-");
  return `vitexec-${name || "index"}`;
}

function assetText(source: string | Uint8Array): string {
  return typeof source === "string" ? source : new TextDecoder().decode(source);
}

export function vitexec(options: VitexecPluginOptions = {}): Plugin {
  let state: PluginState | undefined;
  let coordinator = false;
  const buildReferences = new Map<string, string>();

  const activeState = (): PluginState | undefined =>
    coordinator ? state : undefined;

  return {
    name: "vitexec",
    configResolved(config) {
      state = states.get(config);
      if (!state) {
        state = {
          config,
          directories: new Set(),
          pages: new Map()
        };
        states.set(config, state);
        coordinator = true;
      }
      addOptions(state, options);
    },
    configureServer(server) {
      const current = activeState();
      if (!current) return;

      server.middlewares.use(async (request, response, next) => {
        if (!request.url || (request.method !== "GET" && request.method !== "HEAD")) return next();

        try {
          const page = pagePath(request.url, current.config.base);
          if (page === "/" || (!page.endsWith(".html") && !current.pages.has(page))) {
            return next();
          }

          const source = (await allPages(current)).get(page);
          if (!source || await isHtmlFile(current.config.root, page)) return next();

          const template = await readFile(resolve(current.config.root, "index.html"), "utf8");
          const html = await server.transformIndexHtml(request.url, template, request.originalUrl);
          response.statusCode = 200;
          response.setHeader("content-type", "text/html; charset=utf-8");
          response.setHeader("cache-control", "no-cache");
          response.end(request.method === "HEAD" ? undefined : html);
        } catch (error) {
          next(error);
        }
      });
    },
    async resolveId(id) {
      const current = activeState();
      if (!current) return;

      const codeId = codeIdFromUrl(id, current.config.base);
      if (!codeId) return;

      const source = await moduleById(current, codeId);
      if (!source) return;
      return source.kind === "file"
        ? source.file
        : resolvedModuleId(current.config.root, source);
    },
    async load(id) {
      const current = activeState();
      if (!current) return;

      for (const source of (await allPages(current)).values()) {
        if (source.kind === "inline" && resolvedModuleId(current.config.root, source) === id) {
          return source.code;
        }
      }
    },
    async transformIndexHtml(html: string, context: IndexHtmlTransformContext) {
      const current = activeState();
      if (!current || current.config.command !== "serve") return;

      const source = (await allPages(current)).get(pagePath(context.path, current.config.base));
      if (!source) return;

      return {
        html,
        tags: [
          {
            tag: "script",
            attrs: { type: "module" },
            children: runtimeScript(source, current.config.base),
            injectTo: "head"
          }
        ]
      };
    },
    async buildStart() {
      const current = activeState();
      if (!current || current.config.command !== "build" || current.config.build.ssr) return;

      buildReferences.clear();
      const referencesByModule = new Map<string, string>();
      for (const [page, source] of await allPages(current)) {
        const id = source.kind === "file" ? source.file : moduleUrl(source.id, "/");
        let reference = referencesByModule.get(source.id);
        if (!reference) {
          reference = this.emitFile({
            type: "chunk",
            id,
            name: builtChunkName(page)
          });
          referencesByModule.set(source.id, reference);
        }
        buildReferences.set(page, reference);
      }
    },
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const current = activeState();
        if (!current || buildReferences.size === 0) return;

        const index = bundle["index.html"];
        if (!index || index.type !== "asset") {
          this.error("Vitexec requires a Vite app build with an index.html entry.");
        }

        const template = assetText(index.source);
        for (const [page, reference] of buildReferences) {
          const html = htmlWithScript(
            template,
            builtModuleUrl(current.config.base, this.getFileName(reference))
          );
          const fileName = builtPageFileName(page);
          if (fileName === "index.html") {
            index.source = html;
            continue;
          }
          if (bundle[fileName]) this.error(`Vitexec build page "${page}" already exists.`);
          this.emitFile({ type: "asset", fileName, source: html });
        }
      }
    }
  };
}
