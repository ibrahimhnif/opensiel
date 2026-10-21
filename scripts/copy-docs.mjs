import { cpSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const source = resolve("docs/.vitepress/dist");
const destination = resolve("apps/web/dist/docs");

if (!existsSync(source)) {
  console.error(`docs build not found at ${source}; run pnpm docs:build first`);
  process.exit(1);
}

rmSync(destination, { recursive: true, force: true });
cpSync(source, destination, { recursive: true });
console.log(`copied ${source} -> ${destination}`);
