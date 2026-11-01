#!/usr/bin/env bun
/**
 * ChartWarden - production compose policy gate (#855, #856), `bun run arch:compose-policy`.
 * ---------------------------------------------------------------------------
 * deploy/production/compose.yml runs patient data stores on one VPS. Two things drifted before this gate:
 *  1. Third-party images were pulled by mutable tag (`minio/minio:latest` later became unpullable): a pull could
 *     return different bytes with no source change. Every LITERAL image must be `repo:tag@sha256:<64 hex>` (the tag
 *     stays as the human-readable label). An image that is a `${VAR}` interpolation is the GHCR application image,
 *     whose immutable digest deploy.sh verifies (cosign) before it reaches compose, so it is exempt here.
 *  2. Nothing bounded memory/CPU, so one runaway service could starve Postgres. Every service must set `mem_limit`
 *     and `cpus` (the keys plain `docker compose up` honours, consistent with the clamav entry) or inherit them
 *     through `extends`; postgres must also set `mem_reservation` so its capacity is reserved.
 *  3. CW-RUST-M02 P1 topology (`checkRustTopology`): the Rust API's replay protection is per process and its only
 *     door is a Unix socket shared with `api`. So: at most one service runs the Rust image, it has no `ports`, no
 *     `scale`/`deploy.replicas` above 1, no `CW_RUST_TCP` (the loopback-TCP development listener), and the socket
 *     volume is mounted by `api` and `rust` only.
 *
 * Run:  bun run arch:compose-policy   (in `arch:fitness`)
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSE_PATH = "deploy/production/compose.yml";
/** `repo[:port]/name:tag@sha256:<digest>` - a tag is required beside the digest so a human can read the version. */
const PINNED_IMAGE = /^[^\s@]+:[^\s@/]+@sha256:[0-9a-f]{64}$/;
/** Services that must reserve memory (capacity guaranteed against the other services on the host). */
const MUST_RESERVE = ["postgres"] as const;

interface ComposeService {
  readonly image?: unknown;
  readonly ports?: unknown;
  readonly scale?: unknown;
  readonly deploy?: { readonly replicas?: unknown };
  readonly environment?: unknown;
  readonly volumes?: unknown;
  readonly extends?: { readonly service?: string } | string;
  readonly mem_limit?: unknown;
  readonly cpus?: unknown;
  readonly mem_reservation?: unknown;
}
interface ComposeDoc {
  readonly services?: Readonly<Record<string, ComposeService>>;
}

export function checkCompose(doc: ComposeDoc): string[] {
  const failures: string[] = [];
  const services = doc.services ?? {};
  if (Object.keys(services).length === 0) return ["compose file declares no services"];

  const extendsBase = (svc: ComposeService): string | undefined =>
    typeof svc.extends === "string" ? svc.extends : svc.extends?.service;

  for (const [name, svc] of Object.entries(services)) {
    const base = extendsBase(svc);
    if (
      typeof svc.image === "string" &&
      !svc.image.includes("${") &&
      !PINNED_IMAGE.test(svc.image)
    ) {
      failures.push(
        `${name}: image "${svc.image}" must be pinned as repo:tag@sha256:<64 hex> (#855)`,
      );
    }
    if (svc.image !== undefined && typeof svc.image !== "string")
      failures.push(`${name}: image must be a string`);
    if (svc.image === undefined && base === undefined)
      failures.push(`${name}: no image and no extends`);

    // An extending service inherits limits from its base, which is checked on its own.
    if (base === undefined || svc.mem_limit !== undefined || svc.cpus !== undefined) {
      if (svc.mem_limit === undefined) failures.push(`${name}: missing mem_limit (#856)`);
      if (svc.cpus === undefined) failures.push(`${name}: missing cpus (#856)`);
    }
    if ((MUST_RESERVE as readonly string[]).includes(name) && svc.mem_reservation === undefined) {
      failures.push(`${name}: missing mem_reservation (capacity must be reserved for it) (#856)`);
    }
  }
  return [...failures, ...checkRustTopology(doc)];
}

/** The service name and socket volume the Rust topology rules are written against. */
export const RUST_SERVICE = "rust";
export const RUST_SOCKET_VOLUME = "rust-sock";
const RUST_IMAGE_RE = /chartwarden-rust|CHARTWARDEN_RUST_IMAGE/;
const RUST_SOCKET_CONSUMERS = new Set(["api", RUST_SERVICE]);
/** What `!reset` loads as, so `extends` resolution can tell "cleared" from "absent". */
export const RESET = Object.freeze({ __composeReset: true });
const isReset = (v: unknown): boolean => v === RESET;

type Svc = ComposeService & {
  readonly env_file?: unknown;
  readonly volumes_from?: unknown;
  readonly [k: string]: unknown;
};

/**
 * The service as compose runs it: `extends` applied (recursively), sequences from the base appended to the
 * service's own unless the service `!reset` them, scalars overridden. Enough fidelity for the topology rules.
 */
export function resolveService(
  services: Readonly<Record<string, Svc>>,
  name: string,
  seen = new Set<string>(),
): Svc {
  const svc = services[name] ?? {};
  const baseName = typeof svc.extends === "string" ? svc.extends : svc.extends?.service;
  if (!baseName || seen.has(name)) return svc;
  seen.add(name);
  const base = resolveService(services, baseName, seen);
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(svc)) {
    if (k === "extends") continue;
    if (isReset(v)) out[k] = undefined;
    else if (Array.isArray(v) && Array.isArray(base[k])) out[k] = [...(base[k] as unknown[]), ...v];
    else out[k] = v;
  }
  return out as Svc;
}

function mentionsVolume(svc: Svc, volume: string): boolean {
  if (!Array.isArray(svc.volumes)) return false;
  return svc.volumes.some((v) =>
    typeof v === "string"
      ? v.split(":")[0] === volume
      : (v as { source?: unknown })?.source === volume,
  );
}

function envHas(svc: Svc, key: string): boolean {
  const env = svc.environment;
  if (Array.isArray(env)) return env.some((e) => typeof e === "string" && e.split("=")[0] === key);
  return env !== null && typeof env === "object" && key in env;
}

/** CW-RUST-M02 P1: exactly one Rust instance, reachable only through the socket shared with `api`. */
export function checkRustTopology(doc: ComposeDoc): string[] {
  const failures: string[] = [];
  const raw = (doc.services ?? {}) as Readonly<Record<string, Svc>>;
  const resolved = Object.fromEntries(Object.keys(raw).map((n) => [n, resolveService(raw, n)]));
  const isRust = (name: string, svc: Svc) =>
    name === RUST_SERVICE || (typeof svc.image === "string" && RUST_IMAGE_RE.test(svc.image));
  const rustServices = Object.entries(resolved).filter(([n, svc]) => isRust(n, svc));
  if (rustServices.length > 1) {
    failures.push(
      `more than one service runs the Rust image (${rustServices.map(([n]) => n).join(", ")}): its replay cache is per process`,
    );
  }
  for (const [name, svc] of rustServices) {
    if (name !== RUST_SERVICE)
      failures.push(`${name}: the Rust image must run as the "${RUST_SERVICE}" service`);
    if (svc.ports !== undefined && !(Array.isArray(svc.ports) && svc.ports.length === 0)) {
      failures.push(`${name}: the Rust service must not publish ports (Unix socket only)`);
    }
    if (svc.scale !== undefined && svc.scale !== 1)
      failures.push(`${name}: scale must be absent or 1`);
    if (svc.deploy?.replicas !== undefined && svc.deploy.replicas !== 1) {
      failures.push(`${name}: deploy.replicas must be absent or 1`);
    }
    if (envHas(svc, "CW_RUST_TCP")) {
      failures.push(`${name}: CW_RUST_TCP (development TCP listener) is not allowed in production`);
    }
    if (svc.env_file !== undefined) {
      failures.push(
        `${name}: the Rust service takes no env_file (it could carry CW_RUST_TCP or another service's secrets)`,
      );
    }
    if (!mentionsVolume(svc, RUST_SOCKET_VOLUME)) {
      failures.push(`${name}: must mount the "${RUST_SOCKET_VOLUME}" socket volume`);
    }
  }
  for (const [name, svc] of Object.entries(resolved)) {
    if (mentionsVolume(svc, RUST_SOCKET_VOLUME) && !RUST_SOCKET_CONSUMERS.has(name)) {
      failures.push(
        `${name}: only api and ${RUST_SERVICE} may mount the "${RUST_SOCKET_VOLUME}" socket volume`,
      );
    }
    const from = Array.isArray(svc.volumes_from) ? (svc.volumes_from as unknown[]).map(String) : [];
    for (const f of from) {
      const target = f.replace(/^(service|container):/, "").split(":")[0] ?? "";
      if (RUST_SOCKET_CONSUMERS.has(target) || rustServices.some(([n]) => n === target)) {
        failures.push(`${name}: volumes_from ${target} would share the Rust socket`);
      }
    }
  }
  return failures;
}

export function loadCompose(path = join(REPO_ROOT, COMPOSE_PATH)): ComposeDoc {
  // `!reset` (compose-specific tag) is not in the default schema: treat it as a plain empty value.
  // `!reset` loads as the RESET marker so `extends` resolution (checkRustTopology) can honour it.
  const resetTag = new yaml.Type("!reset", { kind: "sequence", construct: () => RESET });
  const schema = yaml.DEFAULT_SCHEMA.extend([resetTag]);
  return yaml.load(readFileSync(path, "utf8"), { schema }) as ComposeDoc;
}

if (import.meta.main) {
  const failures = checkCompose(loadCompose());
  if (failures.length > 0) {
    console.error(`arch:compose-policy FAILED (${COMPOSE_PATH}):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(
    "arch:compose-policy OK: every literal image is digest-pinned, every service is resource-bounded, and the Rust topology holds.",
  );
}
