// Build every root project reference in bounded processes. TypeScript's build mode retains
// project state for the lifetime of one process; on the CI runner the full graph was OOM-killed.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const root = JSON.parse(readFileSync(new URL("../tsconfig.json", import.meta.url), "utf8")) as {
  references: Array<{ path: string }>;
};
const projects = root.references.map(({ path }) => path);
const batches: string[][] = [];
let packageBatch: string[] = [];
for (const project of projects) {
  if (project.startsWith("./packages/")) {
    packageBatch.push(project);
    if (packageBatch.length === 6) {
      batches.push(packageBatch);
      packageBatch = [];
    }
  } else {
    if (packageBatch.length) batches.push(packageBatch);
    packageBatch = [];
    batches.push([project]);
  }
}
if (packageBatch.length) batches.push(packageBatch);

for (const [index, batch] of batches.entries()) {
  console.log(`TypeScript batch ${index + 1}/${batches.length}: ${batch.join(", ")}`);
  const result = spawnSync("tsc", ["-b", ...batch], {
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_OPTIONS: process.env.BUILD_NODE_OPTIONS ?? "--max-old-space-size=4096",
    },
  });
  if (result.error) throw result.error;
  if (result.signal) console.error(`TypeScript batch ${index + 1} received ${result.signal}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
