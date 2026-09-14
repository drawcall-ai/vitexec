import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { VitexecModuleExtension } from "../index.js";

export async function resolveVitexecCodeInput(
  codeParts: string[],
  cwd = process.cwd()
): Promise<string> {
  return (await resolveVitexecCodeInputDetails(codeParts, cwd)).code;
}

export type ResolvedVitexecCodeInput = {
  code: string;
  moduleExtension: VitexecModuleExtension;
};

export async function resolveVitexecCodeInputDetails(
  codeParts: string[],
  cwd = process.cwd()
): Promise<ResolvedVitexecCodeInput> {
  if (codeParts.length !== 1) {
    return { code: codeParts.join(" "), moduleExtension: ".js" };
  }

  const input = codeParts[0];
  const directPath = resolve(cwd, input);
  const vitexecPath = resolve(cwd, "vitexec", input);
  let filePath: string | undefined;
  if (await isFile(directPath)) filePath = directPath;
  else if (await isFile(vitexecPath)) filePath = vitexecPath;
  if (!filePath) return { code: input, moduleExtension: ".js" };

  return {
    code: await readFile(filePath, "utf8"),
    moduleExtension: moduleExtensionFromPath(filePath)
  };
}

function moduleExtensionFromPath(path: string): VitexecModuleExtension {
  const extension = extname(path);
  return isModuleExtension(extension) ? extension : ".js";
}

function isModuleExtension(value: string): value is VitexecModuleExtension {
  return [".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"].includes(value);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (isFileMissingError(error)) return false;
    throw error;
  }
}

function isFileMissingError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" ||
      error.code === "ENOTDIR" ||
      error.code === "ENAMETOOLONG")
  );
}

