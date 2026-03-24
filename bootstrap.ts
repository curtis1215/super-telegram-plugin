import { existsSync } from "fs";
import { join, dirname } from "path";
import { spawnSync } from "child_process";

const root = dirname(new URL(import.meta.url).pathname);
const nodeModules = join(root, "node_modules");

if (!existsSync(nodeModules)) {
  const result = spawnSync("bun", ["install"], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

await import("./proxy/server.ts");
