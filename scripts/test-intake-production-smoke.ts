import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyLocalDockerDaemon } from "./intake-docker-safety";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const BASE_COMPOSE = "docker-compose.yml";
const SMOKE_COMPOSE = "scripts/intake-production-smoke.override.yml";
export const INTAKE_SMOKE_PROJECT_PREFIX = "cw-intake-oa-smoke-";

const SAFE_HOST_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "TMPDIR",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
] as const;

const DISABLED_EXTERNAL_ENV = {
  MESSAGING_ENCRYPTION_KEY: "",
  MESSAGING_WEBHOOK_PUBLIC_BASE_URL: "",
  POSTMARK_SERVER_TOKEN: "",
  POSTMARK_FROM_ADDRESS: "",
  POSTMARK_SENDER_VERIFIED: "false",
  POSTMARK_WEBHOOK_TOKEN: "",
  TWILIO_ACCOUNT_SID: "",
  TWILIO_AUTH_TOKEN: "",
  TWILIO_MESSAGING_SERVICE_SID: "",
  TWILIO_SMS_FROM: "",
  TWILIO_VOICE_FROM: "",
  APNS_BUNDLE_ID: "",
  APNS_ENVIRONMENT: "",
  APNS_KEY_ID: "",
  APNS_KEY_P8: "",
  APNS_TEAM_ID: "",
  FCM_SERVICE_ACCOUNT_JSON: "",
  VAPID_PRIVATE_KEY: "",
  VAPID_PUBLIC_KEY: "",
  VAPID_SUBJECT: "",
  M24_CREDENTIAL_ENCRYPTION_KEY: "",
  M24_LAUNCH_GATEWAY_ENABLED: "false",
} satisfies NodeJS.ProcessEnv;

export function isolatedComposeEnvironment(host: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...DISABLED_EXTERNAL_ENV };
  for (const key of SAFE_HOST_ENV_KEYS) {
    if (host[key] !== undefined) env[key] = host[key];
  }
  return env;
}

export function assertSafeIntakeSmokeProject(project: string): void {
  if (!new RegExp(`^${INTAKE_SMOKE_PROJECT_PREFIX}[a-z0-9]{12}$`).test(project)) {
    throw new Error("refusing non-isolated compose project name");
  }
}

export function addCleanupFailure(primary: unknown): Error {
  const cleanup = new Error("isolated smoke cleanup failed");
  if (!primary) return cleanup;
  const cause = primary instanceof Error ? primary : new Error(String(primary));
  return new AggregateError(
    [cause, cleanup],
    `${cause.message}; isolated smoke cleanup also failed`,
  );
}

function run(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  options: { quiet?: boolean; allowFailure?: boolean } = {},
) {
  const result = spawnSync(command, [...args], {
    cwd: ROOT,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!options.quiet && result.stdout) process.stdout.write(result.stdout);
  if (!options.quiet && result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${command} exited ${result.status ?? "without an exit code"}`);
  }
  return result;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate loopback port");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return port;
}

async function waitForHealthy(
  compose: readonly string[],
  env: NodeJS.ProcessEnv,
  service: string,
): Promise<void> {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const id = run("docker", [...compose, "ps", "-q", service], env, { quiet: true }).stdout.trim();
    if (id) {
      const state = run(
        "docker",
        [
          "inspect",
          "--format",
          "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}",
          id,
        ],
        env,
        { quiet: true },
      ).stdout.trim();
      if (state === "healthy") return;
      if (state === "unhealthy" || state === "exited" || state === "dead") {
        throw new Error(`${service} became ${state}`);
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
  }
  throw new Error(`${service} did not become healthy`);
}

export async function main(): Promise<void> {
  const suffix = randomBytes(6).toString("hex");
  const project = `${INTAKE_SMOKE_PROJECT_PREFIX}${suffix}`;
  assertSafeIntakeSmokeProject(project);
  const [postgresPort, redisPort, objectPort, apiPort, workerPort] = await Promise.all([
    freePort(),
    freePort(),
    freePort(),
    freePort(),
    freePort(),
  ]);
  const stackId = `cw-intake-oa-smoke-${suffix}`;
  const env: NodeJS.ProcessEnv = {
    ...isolatedComposeEnvironment(process.env),
    INTAKE_COMPOSE_PROJECT: project,
    INTAKE_STACK_ID: stackId,
    INTAKE_POSTGRES_PORT: String(postgresPort),
    INTAKE_REDIS_PORT: String(redisPort),
    INTAKE_OBJECT_PORT: String(objectPort),
    INTAKE_API_PORT: String(apiPort),
    INTAKE_WORKER_PORT: String(workerPort),
    // Ephemeral acceptance-only material: inherited by Compose, never printed or persisted in the repo.
    M35_PSEUDONYM_KEY_KEK: `oa-${suffix}:${randomBytes(32).toString("base64")}`,
  };
  // An explicit empty env file prevents Compose from loading the developer's cwd .env. Only the
  // allowlisted host settings and synthetic values above can participate in interpolation.
  const compose = [
    "compose",
    "--env-file",
    "/dev/null",
    "-p",
    project,
    "-f",
    BASE_COMPOSE,
    "-f",
    SMOKE_COMPOSE,
  ] as const;
  let failure: unknown;
  let localDaemonVerified = false;
  let passEvidence: Record<string, string> | undefined;
  try {
    verifyLocalDockerDaemon(env);
    localDaemonVerified = true;
    run(
      "docker",
      [
        ...compose,
        "up",
        "-d",
        "--build",
        "postgres",
        "redis",
        "rustfs",
        "clamav",
        "migrate",
        "provision-gateway",
        "api",
        "worker",
      ],
      env,
    );
    await Promise.all([
      waitForHealthy(compose, env, "clamav"),
      waitForHealthy(compose, env, "api"),
      waitForHealthy(compose, env, "worker"),
    ]);

    const readiness = (await fetch(`http://127.0.0.1:${apiPort}/ready`).then(async (response) => {
      const body = (await response.json()) as { checks?: Record<string, unknown> };
      if (!response.ok) throw new Error(`api readiness returned ${response.status}`);
      return body;
    })) as { checks?: Record<string, unknown> };
    if (readiness.checks?.minio !== "ok") {
      throw new Error("api readiness did not verify object storage");
    }

    const metrics = await fetch(`http://127.0.0.1:${workerPort}/metrics`).then(async (response) => {
      if (!response.ok) throw new Error(`worker metrics returned ${response.status}`);
      return response.text();
    });
    for (const state of ["waiting", "active", "delayed", "failed"]) {
      if (
        !metrics.includes(
          `chartwarden_bullmq_queue_jobs{queue="m22-doclens-intake",state="${state}"}`,
        )
      ) {
        throw new Error(`worker metrics omitted m22-doclens-intake state ${state}`);
      }
    }

    const scannerProbe = String.raw`
      import { createClamdDocumentScanner } from './apps/backend/src/modules/22-documents/routes/document-content-scanner.ts';
      const scanner = createClamdDocumentScanner({ host: process.env.CLAMD_HOST, port: Number(process.env.CLAMD_PORT ?? 3310) });
      const clean = await scanner.scan({ bytes: Buffer.from('%PDF-1.4 synthetic acceptance'), mimeType: 'application/pdf' });
      const eicar = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*', 'latin1');
      const infected = await scanner.scan({ bytes: eicar, mimeType: 'application/pdf' });
      if (clean.verdict !== 'clean' || infected.verdict !== 'infected') process.exit(1);
      console.log(JSON.stringify({ clean: clean.verdict, eicar: infected.verdict }));
    `;
    run("docker", [...compose, "exec", "-T", "api", "bun", "-e", scannerProbe], env);

    const keyProbe = String.raw`
      import { loadPseudonymKekRing } from '@chartwarden/subscription-billing';
      const ring = loadPseudonymKekRing(process.env);
      if (!ring) process.exit(1);
      console.log(JSON.stringify({ m35PseudonymKek: 'configured' }));
    `;
    run("docker", [...compose, "exec", "-T", "worker", "bun", "-e", keyProbe], env);
    passEvidence = {
      result: "PASS",
      stackId,
      workerMetrics: "m22-doclens-intake bounded states present",
      clamav: "clean accepted; EICAR rejected",
      objectStorage: "signed readiness probe passed",
      m35PseudonymKek: "configured",
    };
  } catch (error) {
    failure = error;
  } finally {
    if (localDaemonVerified) {
      const cleanup = run("docker", [...compose, "down", "-v", "--remove-orphans"], env, {
        quiet: true,
        allowFailure: true,
      });
      if (cleanup.status !== 0) failure = addCleanupFailure(failure);
    }
  }
  if (failure) throw failure;
  if (!passEvidence) throw new Error("smoke completed without acceptance evidence");
  console.log(JSON.stringify({ ...passEvidence, completedAt: new Date().toISOString() }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
