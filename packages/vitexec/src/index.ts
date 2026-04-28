import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { z } from "zod";

export const VITEXEC_PARAM = "__vitexec";
export const VITEXEC_ROUTE = "/__vitexec";
export const VITEXEC_UPLOAD_ROUTE = `${VITEXEC_ROUTE}/upload`;
export const VITEXEC_CODE_ROUTE = `${VITEXEC_ROUTE}/code`;

const idSchema = z.string().min(1, "id is required");
const codeSchema = z.string();

type CodeStore = Map<string, string>;
type Route = { kind: "upload" | "code"; id: string };
type RouteMatch = Route | { kind: "bad-route"; message: string };

function decodeId(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function matchRoute(url: string): RouteMatch | undefined {
  const { pathname } = new URL(url, "http://vitexec.local");
  const match = pathname.match(/^\/__vitexec\/(upload|code)\/(.+)$/);
  if (!match) return undefined;

  const decodedId = decodeId(match[2]);
  const parsed = decodedId && idSchema.safeParse(decodedId);
  if (!parsed || !parsed.success) {
    return {
      kind: "bad-route",
      message: parsed ? parsed.error.issues[0]?.message ?? "invalid id" : "invalid id"
    };
  }

  return {
    kind: match[1] as Route["kind"],
    id: parsed.data
  };
}

function text(
  response: ServerResponse,
  statusCode: number,
  body: string,
  contentType = "text/plain; charset=utf-8"
): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", contentType);
  response.end(body);
}

const runtimeScript = `
const id = new URLSearchParams(location.search).get(${JSON.stringify(VITEXEC_PARAM)});
if (id) {
  import(${JSON.stringify(VITEXEC_CODE_ROUTE)} + "/" + encodeURIComponent(id)).catch(console.error);
}
`;

export function buildVitexecUrl(base: string, id: string): string {
  const url = new URL(base);
  url.searchParams.set(VITEXEC_PARAM, id);
  return url.toString();
}

export async function uploadCode(
  viteUrl: string,
  id: string,
  code: string
): Promise<void> {
  const url = new URL(viteUrl);
  url.pathname = `${VITEXEC_UPLOAD_ROUTE}/${encodeURIComponent(id)}`;
  url.search = "";
  url.hash = "";

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "text/plain; charset=utf-8"
    },
    body: code
  });

  if (!response.ok) {
    throw new Error(
      `Could not upload code "${id}" to ${url.origin}: ${response.status} ${response.statusText}`
    );
  }
}

async function handleUpload(
  request: IncomingMessage,
  response: ServerResponse,
  store: CodeStore,
  id: string
): Promise<void> {
  if (request.method !== "POST") return text(response, 405, "Use POST to upload code.");

  store.set(id, codeSchema.parse(await readRequestBody(request)));
  text(response, 204, "");
}

function handleCode(response: ServerResponse, store: CodeStore, id: string): void {
  const code = store.get(id);
  text(
    response,
    code === undefined ? 404 : 200,
    code ?? `No vitexec code found for id "${id}".`,
    code === undefined ? undefined : "text/javascript; charset=utf-8"
  );
}

export function vitexec(): Plugin {
  let isDevServer = false;
  const uploadedCode = new Map<string, string>();

  return {
    name: "vitexec",
    apply: "serve",
    configResolved(config) {
      isDevServer = config.command === "serve";
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const route = request.url && matchRoute(request.url);
        if (!route) return next();
        if (route.kind === "bad-route") return text(response, 400, route.message);
        if (route.kind === "upload") return handleUpload(request, response, uploadedCode, route.id);
        if (request.method !== "GET") return text(response, 405, "Use GET to load code.");
        return handleCode(response, uploadedCode, route.id);
      });
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
            children: runtimeScript,
            injectTo: "head"
          }
        ]
      };
    }
  };
}

export default vitexec;
