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
    if (typeof svc.image === "string" && !svc.image.includes("${") && !PINNED_IMAGE.test(svc.image)) {
      failures.push(`${name}: image "${svc.image}" must be pinned as repo:tag@sha256:<64 hex> (#855)`);
    }
    if (svc.image !== undefined && typeof svc.image !== "string") failures.push(`${name}: image must be a string`);
    if (svc.image === undefined && base === undefined) failures.push(`${name}: no image and no extends`);

    // An extending service inherits limits from its base, which is checked on its own.
    if (base === undefined || svc.mem_limit !== undefined || svc.cpus !== undefined) {
      if (svc.mem_limit === undefined) failures.push(`${name}: missing mem_limit (#856)`);
      if (svc.cpus === undefined) failures.push(`${name}: missing cpus (#856)`);
    }
    if ((MUST_RESERVE as readonly string[]).includes(name) && svc.mem_reservation === undefined) {
      failures.push(`${name}: missing mem_reservation (capacity must be reserved for it) (#856)`);
    }
  }
  return failures;
}

export function loadCompose(path = join(REPO_ROOT, COMPOSE_PATH)): ComposeDoc {
  // `!reset` (compose-specific tag) is not in the default schema: treat it as a plain empty value.
  const resetTag = new yaml.Type("!reset", { kind: "sequence", construct: () => [] });
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
  console.log("arch:compose-policy OK: every literal image is digest-pinned and every service is resource-bounded.");
}
