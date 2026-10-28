/**
 * ChartWarden — docling-worker lock freshness gate (#853 / CW-QA-0009)
 * ---------------------------------------------------------------------
 * The docling-worker image installs exactly `services/docling-worker/uv.lock` (`uv sync --frozen`). A frozen
 * sync does not notice that pyproject.toml moved on, so an edited dependency range with a forgotten
 * `uv lock` would ship the OLD graph while the diff reads as the new one. `uv lock --check` fails when the
 * lock no longer satisfies pyproject.toml (it re-resolves from the lock, so it is offline when they agree).
 *
 * A missing `uv` is a FAILURE, not a skip: a gate that silently passes where it cannot run is the exact
 * "green gates are proxies" trap CLAUDE.md warns about.
 *
 * Run:   bun run scripts/check-docling-lock.ts      (arch:fitness stage)
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const WORKER_DIR = join(process.cwd(), "services", "docling-worker");

function fail(message: string): never {
  console.error(`arch:docling-lock FAIL: ${message}`);
  process.exit(1);
}

if (!existsSync(join(WORKER_DIR, "uv.lock"))) {
  fail("services/docling-worker/uv.lock is missing (it must be committed; see services/docling-worker/README.md).");
}

const run = spawnSync("uv", ["lock", "--check"], { cwd: WORKER_DIR, encoding: "utf8" });
if (run.error) {
  fail(`could not run 'uv' (${run.error.message}). Install uv 0.9.x: pip install uv==0.9.10`);
}
if (run.status !== 0) {
  process.stderr.write(run.stderr);
  fail("uv.lock is stale vs pyproject.toml. Run `uv lock` in services/docling-worker and commit the result.");
}

console.log("arch:docling-lock OK: services/docling-worker/uv.lock satisfies pyproject.toml");
