import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createBrowser, createServer, run } from "vitexec/cli";

const server = await createServer({ root: fileURLToPath(new URL(".", import.meta.url)) });
try {
  const browser = await createBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(server.url);
    const code = file => readFile(new URL(`scripts/${file}.js`, import.meta.url), "utf8");
    const options = { onLog: console.log, timeoutMs: 10000 };
    await run(page, await code("1-walk"), options);
    await run(page, await code("2-aim"), options);
    await run(page, await code("3-deliver"), options);
  } finally {
    await browser.close();
  }
} finally {
  await server.close();
}
