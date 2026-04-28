import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ViteDevServer } from "vite";
import { createServer } from "vite";
import { vitexec } from "../src/index.js";

export interface TestServer {
  root: string;
  url: string;
  server: ViteDevServer;
  close: () => Promise<void>;
}

export async function createTempViteServer(
  files: Record<string, string>
): Promise<TestServer> {
  const root = await mkdtemp(join(tmpdir(), "vitexec-"));

  await Promise.all(
    Object.entries(files).map(async ([path, contents]) => {
      const filePath = join(root, path);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, contents);
    })
  );

  const server = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    server: {
      host: "127.0.0.1"
    },
    plugins: [vitexec()]
  });

  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start test Vite server.");
  }

  return {
    root,
    server,
    url: `http://127.0.0.1:${address.port}/`,
    async close() {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

export async function createExampleServer(): Promise<TestServer> {
  const root = fileURLToPath(
    new URL("../../../examples/basic-three/", import.meta.url)
  );
  const server = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    server: {
      host: "127.0.0.1"
    },
    plugins: [vitexec()]
  });

  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start example Vite server.");
  }

  return {
    root,
    server,
    url: `http://127.0.0.1:${address.port}/`,
    async close() {
      await server.close();
    }
  };
}
