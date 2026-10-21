// @chartwarden/terminology-loader — the generic version-load orchestrator (M38 §2.4.2, §3.1 `load.ts`, §4.3).
//
//   loading ──fetch · checksum · parse · stage──▶ staged ──activate──▶ active (prior ──▶ superseded)
//      └────────────── deterministic fault ──────────────▶ failed (staging deleted; no concept rows exist)
//
// RESUME. A `staged` version is never re-parsed: the next run goes straight to activation (spec §7.10 "next run
// resumes from staged; no half-active version exposed"). A `loading` version restarts staging from scratch
// (the first staged chunk resets this version's staging), so a crash mid-stage leaves nothing the next run trips on.
// IDEMPOTENT. `active`/`superseded` → no-op; `failed` → no-op (re-register the version to retry).
// FAILURE ISOLATION. A {@link LoaderDataError} (bad checksum, unparsable source, refused licence, a version that is
// not newer than the active one) FAILS the version and returns; any other error is rethrown so the queue retries it.
import { sha256Hex } from "./bytes";
import { buildDeprecationHints, chunk, conceptToStagedRow, hintToStagedRow } from "./diff";
import { LoaderDataError, isDataError, reasonOf } from "./errors";
import { evaluateLicenseGate } from "./license";
import { parseSource } from "./parsers/index";
import type {
  ActivationSummary,
  FollowUpPort,
  LoaderLogger,
  LoaderStorePort,
  PlatformObjectPort,
  StageSummary,
} from "./ports";
import type { LoadableSystemId } from "./types";

/** Rows per staging call: bounds one definer-function payload (the DB rejects more than 5000). */
export const STAGE_CHUNK_SIZE = 2000;

export interface LoadVersionDeps {
  readonly store: LoaderStorePort;
  readonly objects: PlatformObjectPort;
  readonly followUps: FollowUpPort;
  readonly log: LoaderLogger;
  /** Injected clock (ISO date) for the licence gate. */
  readonly today: () => string;
  /** True when the embeddings backend is configured; false skips the embeddings follow-up (stated, not faked). */
  readonly embeddingsAvailable: boolean;
}

export interface LoadVersionJob {
  readonly versionId: string;
  /** false = stage only (the Sep 15 ICD-10-CM dry run); default true. */
  readonly activate?: boolean;
  readonly actorUserId?: string | null;
}

export type LoadOutcome =
  | {
      readonly outcome: "activated";
      readonly stage: StageSummary | null;
      readonly activation: ActivationSummary;
    }
  | { readonly outcome: "staged"; readonly stage: StageSummary | null }
  | { readonly outcome: "noop"; readonly status: string }
  | { readonly outcome: "failed"; readonly reason: string };

/** Run (or resume) the load of one registered version. */
export async function runLoadVersion(
  deps: LoadVersionDeps,
  job: LoadVersionJob,
): Promise<LoadOutcome> {
  const { store, log } = deps;
  const version = await store.getVersion(job.versionId);
  if (!version)
    throw new LoaderDataError("VERSION_NOT_FOUND", `no code_system_version ${job.versionId}`);
  if (version.status !== "loading" && version.status !== "staged") {
    return { outcome: "noop", status: version.status };
  }
  try {
    await assertLicensed(deps, version.system);
    const stage = version.status === "loading" ? await stageVersion(deps, version) : null;
    if (job.activate === false) {
      return { outcome: "staged", stage };
    }
    const activation = await store.activate(version.id, job.actorUserId ?? null);
    await enqueueFollowUps(deps, version.system, version.id, version.effectiveFrom, activation);
    log.info(
      {
        event: "terminology.version_loaded",
        system: version.system,
        versionId: version.id,
        ...activation,
      },
      "terminology version activated",
    );
    return { outcome: "activated", stage, activation };
  } catch (err) {
    if (!isDataError(err)) throw err;
    const reason = reasonOf(err);
    await store.fail(version.id, reason);
    log.error(
      {
        event: "terminology.version_load_failed",
        system: version.system,
        version: version.version,
        reason,
      },
      "terminology version load failed",
    );
    return { outcome: "failed", reason };
  }
}

async function assertLicensed(deps: LoadVersionDeps, system: LoadableSystemId): Promise<void> {
  const [source, attestations] = await Promise.all([
    deps.store.licenseSource(system),
    deps.store.licenseAttestations(system),
  ]);
  const verdict = evaluateLicenseGate(system, source, attestations, deps.today());
  if (!verdict.allowed) {
    throw new LoaderDataError(
      `TERMINOLOGY_LICENSE_${verdict.reason}`,
      `${system} may not be loaded: ${verdict.reason}`,
    );
  }
}

async function stageVersion(
  deps: LoadVersionDeps,
  version: NonNullable<Awaited<ReturnType<LoaderStorePort["getVersion"]>>>,
): Promise<StageSummary> {
  const { store, objects } = deps;
  // A missing object is a SourceNotFoundError (data fault → fail); a transport error propagates → job retry.
  const bytes = await objects.read(version.sourceFileRef);
  const actual = sha256Hex(bytes);
  if (actual !== version.checksum.toLowerCase()) {
    throw new LoaderDataError(
      "CHECKSUM_MISMATCH",
      "source file sha256 does not match the registered checksum",
    );
  }
  const parsed = parseSource(version.system, bytes);
  const prior =
    version.system === "icd10cm" ? await store.listActiveConcepts(version.system, version.id) : [];
  const hints = buildDeprecationHints(version.system, prior, parsed.concepts);
  const rows = parsed.concepts.map(conceptToStagedRow);
  let first = true;
  for (const part of chunk(rows, STAGE_CHUNK_SIZE)) {
    await store.stageRows(version.id, "concept", part, first);
    first = false;
  }
  for (const part of chunk(hints.map(hintToStagedRow), STAGE_CHUNK_SIZE)) {
    await store.stageRows(version.id, "deprecation", part, false);
  }
  for (const w of parsed.warnings)
    deps.log.warn({ system: version.system, versionId: version.id }, w);
  return store.markStaged(version.id, rows.length);
}

async function enqueueFollowUps(
  deps: LoadVersionDeps,
  system: LoadableSystemId,
  versionId: string,
  effectiveFrom: string,
  activation: ActivationSummary,
): Promise<void> {
  const { followUps, log } = deps;
  // Each follow-up is best-effort relative to the activation: the version IS active; a Valkey blip enqueuing a
  // follow-up must not turn a successful load into a failed job (the admin route / next scheduled run can re-drive).
  const steps: [string, () => Promise<void>][] = [
    ["refresh_expansions", () => followUps.enqueueRefreshExpansions(system, versionId)],
  ];
  if (deps.embeddingsAvailable) {
    steps.push(["refresh_embeddings", () => followUps.enqueueRefreshEmbeddings(system, versionId)]);
  } else {
    log.warn(
      { system, versionId },
      "embeddings backend not configured; semantic search stays on fuzzy for this version",
    );
  }
  if (activation.deprecations > 0) {
    steps.push([
      "tenant_deprecation_scan",
      () => followUps.enqueueTenantDeprecationScan(system, versionId, effectiveFrom),
    ]);
  }
  for (const [name, run] of steps) {
    try {
      await run();
    } catch (err) {
      log.error(
        { system, versionId, followUp: name, reason: reasonOf(err) },
        "follow-up enqueue failed",
      );
    }
  }
}
