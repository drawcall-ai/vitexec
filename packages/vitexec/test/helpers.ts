import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface TestProject {
  root: string;
  close: () => Promise<void>;
}

export async function createTempViteProject(
  files: Record<string, string>
): Promise<TestProject> {
  const tempBase = join(
    fileURLToPath(new URL("../node_modules/", import.meta.url)),
    "vitexec-"
  );
  const root = await mkdtemp(tempBase);

  await Promise.all(
    Object.entries(files).map(async ([path, contents]) => {
      const filePath = join(root, path);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, contents);
    })
  );

  return {
    root,
    async close() {
      await rm(root, { recursive: true, force: true });
    }
  };
}
