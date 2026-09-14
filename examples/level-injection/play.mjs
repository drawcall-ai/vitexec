import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { openPage, run } from "vitexec/cli";

const page = await openPage({
  root: fileURLToPath(new URL(".", import.meta.url)),
  onLog: console.log
});
try {
  const code = file => readFile(new URL(`scripts/${file}.js`, import.meta.url), "utf8");
  const options = { onLog: console.log, timeoutMs: 10000 };
  await run(page, await code("1-walk"), options);
  await run(page, await code("2-aim"), options);
  await run(page, await code("3-deliver"), options);
} finally {
  await page.close();
}
