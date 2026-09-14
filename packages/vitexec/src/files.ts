import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function ensureParentDir(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await ensureParentDir(path);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
