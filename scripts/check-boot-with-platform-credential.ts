/**
 * WardenX — Production-configuration BOOT check  (F-020 / issue #49)
 * ------------------------------------------------------------------
 * Start the backend the way a production deployment starts it — with `DATABASE_PLATFORM_URL` set —
 * and prove the process reaches `listen()` with the outbox relay running.
 *
 * WHY THIS EXISTS. Several boot-time validations only run on the platform-credential branch, the
 * outbox dispatcher's catalog check among them (`assertBindableAgainstCatalog`). Nothing in CI ever
 * took that branch, so "does the process start in the configuration we document" was untested: two
 * outbox catalog mismatches accumulated and the backend refused to start in every deployment that
 * followed the docs. `arch:outbox-bindings` catches that particular class at build time; this catches
 * the REST of the branch — a bad enumerator wiring, a missing grant, an import cycle that only bites
 * when the platform pool is constructed.
 *
 * WHAT IT ASSERTS
 *   · the process reaches "Server listening" and answers /health 200 (it did not die at boot);
 *   · the relay actually started ("TASK-006 outbox dispatcher polling"), not merely that boot
 *     survived — the dispatcher being skipped is exactly the silent state this check exists to end.
 *
 * A boot failure exits 1 with the child's captured output, so CI shows the real error, not a timeout.
 *
 * Requires: DATABASE_URL + DATABASE_PLATFORM_URL against a migrated database whose platform login
 * has been provisioned (`bun run db:provision-roles`).
 *
 * Run:  bun run scripts/check-boot-with-platform-credential.ts
 * CI:   the `outbox-boot` job.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";

const BOOT_TIMEOUT_MS = Number(process.env.BOOT_CHECK_TIMEOUT_MS ?? 180_000);
const PORT = process.env.BOOT_CHECK_PORT ?? "3999";
const RELAY_LOG = "TASK-006 outbox dispatcher polling";

for (const key of ["DATABASE_URL", "DATABASE_PLATFORM_URL"]) {
  if (!process.env[key]) {
    console.error(
      `${key} is required — this check exists to exercise the platform-credential boot.`,
    );
    process.exit(1);
  }
}

const child = spawn("bun", ["src/index.ts"], {
  cwd: join(process.cwd(), "apps", "backend"),
  env: {
    ...process.env,
    PORT,
    // The relay is gated on `role !== "api"` (index.ts reads PROCESS_ROLE, default "all"), so an
    // api-only replica would skip the very branch this check exists to exercise.
    PROCESS_ROLE: process.env.PROCESS_ROLE ?? "all",
    NODE_ENV: process.env.NODE_ENV ?? "development",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout.on("data", (chunk: Buffer) => {
  output += chunk.toString();
});
child.stderr.on("data", (chunk: Buffer) => {
  output += chunk.toString();
});

let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
child.on("exit", (code, signal) => {
  exited = { code, signal };
});

const fail = (message: string): never => {
  console.error(`\n✗ ${message}\n`);
  console.error("─── backend output ".padEnd(80, "─"));
  console.error(output.trimEnd() || "(no output)");
  console.error("─".repeat(80));
  if (exited === null) child.kill("SIGKILL");
  process.exit(1);
};

const deadline = Date.now() + BOOT_TIMEOUT_MS;
let healthy = false;
while (Date.now() < deadline) {
  if (exited !== null) {
    const { code, signal } = exited as { code: number | null; signal: NodeJS.Signals | null };
    fail(
      `the backend exited during boot (code ${code}, signal ${signal}) with DATABASE_PLATFORM_URL set`,
    );
  }
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (res.ok) {
      healthy = true;
      break;
    }
  } catch {
    // not listening yet
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

if (!healthy) fail(`the backend did not answer /health within ${BOOT_TIMEOUT_MS}ms`);

// Reaching listen() is not enough: the relay is what the platform credential is FOR, and a skipped
// dispatcher looks exactly like a healthy boot from the outside.
if (!output.includes(RELAY_LOG)) {
  fail(
    `the backend booted but the outbox relay never started (no "${RELAY_LOG}" line) — the dispatcher was skipped, so nothing would drain outbox_event`,
  );
}

child.kill("SIGTERM");
await new Promise((resolve) => setTimeout(resolve, 2_000));
if (exited === null) child.kill("SIGKILL");

console.log(
  `✓ backend booted with DATABASE_PLATFORM_URL set (/health 200 on :${PORT}) and the outbox relay is polling.`,
);
