import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Page } from "playwright";
import type { VitexecInlineModule, VitexecModuleExtension } from "./index.js";

const extensions = [".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"] as const;

/** Server-side source registration; all code still goes through Vite's module pipeline. */
export function createInjection(base: string, urlFor: (id: string) => string) {
  const modules = new Map<string, VitexecInlineModule>();
  const token = randomUUID();
  const pathname = new URL("./__vitexec/inject", `http://vitexec.local${base}`).pathname;
  const endpoint = `${pathname}?token=${token}`;

  return {
    modules,
    endpoint,
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const url = new URL(request.url ?? "/", "http://vitexec.local");
      if (url.pathname !== pathname && url.pathname !== "/__vitexec/inject") return false;
      response.setHeader("cache-control", "no-store");
      if (url.searchParams.get("token") !== token) {
        response.statusCode = 403;
        response.end("Invalid Vitexec registration token.");
        return true;
      }
      const id = url.searchParams.get("id");
      if (!id || !/^[a-zA-Z0-9-]+$/.test(id)) {
        response.statusCode = 400;
        response.end("Invalid Vitexec run ID.");
        return true;
      }
      if (request.method === "DELETE") {
        modules.delete(id);
        response.end();
        return true;
      }
      if (request.method !== "POST") {
        response.statusCode = 405;
        response.end("Expected POST or DELETE.");
        return true;
      }
      const extension = extensions.find(value => value === url.searchParams.get("extension"));
      if (!extension) {
        response.statusCode = 400;
        response.end("Invalid Vitexec module extension.");
        return true;
      }
      request.setEncoding("utf8");
      let code = "";
      for await (const chunk of request) {
        if (typeof chunk !== "string") throw new Error("Invalid Vitexec request body.");
        code += chunk;
        if (Buffer.byteLength(code) > 1024 * 1024) {
          response.statusCode = 413;
          response.end("Vitexec scripts must not exceed 1 MiB.");
          return true;
        }
      }
      modules.set(id, { id, code, moduleExtension: extension });
      response.setHeader("content-type", "text/plain");
      response.end(urlFor(id));
      return true;
    }
  };
}

export async function registerScript(page: Page, id: string, code: string, extension: VitexecModuleExtension = ".js") {
  const registration = await page.evaluate(async ({ id, code, extension }) => {
    const endpoint = document.querySelector('meta[name="vitexec"]')?.getAttribute("content");
    if (!endpoint) {
      throw new Error("This page does not support Vitexec injection. Add vitexec() to the app's Vite plugins and reload it first.");
    }
    const url = new URL(endpoint, location.href);
    url.searchParams.set("id", id);
    url.searchParams.set("extension", extension);
    const response = await fetch(url, { method: "POST", body: code });
    if (!response.ok) throw new Error(`Vitexec registration failed (${response.status}): ${await response.text()}`);
    return { endpoint: url.href, url: new URL(await response.text(), location.href).href };
  }, { id, code, extension });

  return {
    url: registration.url,
    async dispose() {
      // Use the owning context's HTTP client so cleanup also works after page navigation/closure.
      const response = await page.context().request.delete(registration.endpoint);
      if (!response.ok()) throw new Error(`Vitexec cleanup failed (${response.status()}): ${await response.text()}`);
    }
  };
}
