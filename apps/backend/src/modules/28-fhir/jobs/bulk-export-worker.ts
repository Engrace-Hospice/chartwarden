import type { DbClient } from "@wardenx/db";
// apps/backend/src/modules/28-fhir/jobs/bulk-export-worker.ts — the `fhir.bulk-export` worker (GAP-084, §4.8,
// W-FHIR-04). Before this existed `POST /$export` inserted an `accepted` row that nothing ever picked up, and
// the poll answered `output: []` forever.
//
// ONE JOB = ONE ORG = ONE `fhir_bulk_export_job`. Per job it:
//   1. CLAIMS the row `accepted -> in_progress` in a single guarded UPDATE, so a duplicate delivery or a second
//      worker gets nothing and does nothing (idempotent by the DB, not by bookkeeping).
//   2. RE-ENFORCES, at execution time, everything the request path enforced at request time. A bulk export can
//      sit queued for minutes; the client may have been revoked or suspended, lost a scope, or lost its BAA in
//      the meantime, and PHI must not leave on the strength of a stale request-time check:
//        - the client is still `active`;
//        - an M40 BAA is still in force (fail closed);
//        - every requested `_type` is a served resource AND is still within the client's allowed scopes
//          (`system/<Type>.read` or `system/*.read`). The session-narrowed scopes of the request were already
//          validated at request time and are frozen into `resource_types`; this re-checks the registry bound.
//   3. PROJECTS through the SAME pipeline the synchronous reads use (`projectSearch`: owner-module reader seam
//      -> pure R4 mapper -> D3 egress consent gate with `recipientClientId` = the client). A Part 2 / no-consent
//      resource is therefore dropped here exactly as it is on a read, with a `suppressed` advisory that lands in
//      the job's `OperationOutcome.ndjson` error file rather than vanishing.
//   4. WRITES one NDJSON object per resource type under `tenants/<org>/fhir-exports/<job>/<Type>.ndjson` in the
//      tenant's bucket, verifies the store-reported sha256 against the planned checksum, then commits the
//      artifact rows + the `completed` roll-up (`expires_at = completed_at + 24h`) + the outbox event in ONE tx.
//   5. On any failure marks the job `failed` with a PHI-free reason and destroys whatever it had already put.
//
// A job is never reported `completed` when it was truncated: over {@link EXPORT_MAX_RESOURCES_PER_JOB} it FAILS.
// A cancel (DELETE on the poll URL) is observed between patient pages and again at commit; the objects of a
// cancelled run are destroyed.
import {
  type BulkExportArtifactPlan,
  bulkExportCompletedEvent,
  bulkExportFailedEvent,
  computeBulkExportCompletion,
  planBulkExportArtifact,
} from "@wardenx/fhir";
import type { OperationOutcome } from "@wardenx/fhir";
import { runWithRequestContext } from "@wardenx/tenancy";
import type { FhirBulkExportJobId, FhirClientId } from "@wardenx/types";

import { isBaaInForce } from "../routes/client-gates";
import {
  type FhirProjectionContext,
  type FhirProjectionResult,
  type FhirSearchParams,
  projectSearch,
  servedResource,
  supportsInteraction,
} from "../routes/projection";
import {
  type ExportArtifactRecord,
  type ExportJobRecord,
  type ExportOutboxEvent,
  claimExportJob,
  completeExportJob,
  exportJobStatus,
  failExportJob,
  loadExportClient,
  loadExportConfig,
} from "./export-store";
import type {
  ExportPatientEnumeratorPort,
  FhirDisclosureSink,
  FhirExportObjectStore,
  FhirJobBaaPort,
  FhirJobOutboxPort,
} from "./ports";
import { EXPORT_MAX_RESOURCES_PER_JOB, EXPORT_PATIENT_PAGE_SIZE } from "./queues";

/** Per-patient, per-type read ceiling inside one export — far above any real chart, still bounded. */
const PER_PATIENT_RESOURCE_LIMIT = 10_000;
/** `_since` absent means "everything", not the 5-year default window a synchronous search applies. */
const EPOCH_ISO = "1970-01-01T00:00:00.000Z";
const SYSTEM_USER_ID = "";
const OUTCOME_TYPE = "OperationOutcome";

export interface BulkExportWorkerDeps {
  readonly db: DbClient;
  readonly outbox: FhirJobOutboxPort;
  readonly objects: FhirExportObjectStore;
  readonly patients: ExportPatientEnumeratorPort;
  /** Absent ⇒ every export is refused (fail closed), the same posture as the request path. */
  readonly baa?: FhirJobBaaPort;
  /** The §164.528 ledger. Absent ⇒ completion is logged loudly that no accounting row was written. */
  readonly disclosures?: FhirDisclosureSink;
  readonly now?: () => Date;
  readonly log?: {
    error(obj: unknown, msg?: string): void;
    warn(obj: unknown, msg?: string): void;
  };
  /** Test seam: defaults to the real projection pipeline. */
  readonly project?: (
    ctx: FhirProjectionContext,
    resourceType: string,
    params: FhirSearchParams,
  ) => Promise<FhirProjectionResult | null>;
}

export type BulkExportOutcome =
  | { readonly status: "completed"; readonly totalResources: number; readonly artifacts: number }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "cancelled" }
  | { readonly status: "skipped" };

/** A refusal the client may be told about (no PHI, no internals) — everything else becomes a generic reason. */
export class BulkExportRefused extends Error {}

const GENERIC_FAILURE_REASON = "the export could not be completed; see the server log";

const hasReadScope = (allowed: readonly string[], resourceType: string): boolean =>
  allowed.includes(`system/${resourceType}.read`) || allowed.includes("system/*.read");

const unboundSeam = (error: unknown): boolean =>
  error instanceof Error && error.name === "NotImplementedError";

/** An unbound reader degrades ONE type to an advisory, mirroring `$everything` (a refused export would hide the
 *  types that ARE readable). The text is deduplicated so a 10k-patient export carries one line, not 10k. */
const unavailableOutcome = (type: string): OperationOutcome => ({
  resourceType: "OperationOutcome",
  issue: [
    {
      severity: "warning",
      code: "not-supported",
      details: { text: `${type} is unavailable on this deployment: its reader seam is not bound` },
    },
  ],
});

/** What step 2 verified; thrown as {@link BulkExportRefused} so the job fails with a readable reason. */
async function assertExportAllowed(
  deps: BulkExportWorkerDeps,
  job: ExportJobRecord,
  at: Date,
): Promise<void> {
  const client = await loadExportClient(deps.db, job.organizationId, job.clientId);
  if (client === null || client.status !== "active") {
    throw new BulkExportRefused("the requesting client is no longer active");
  }
  const baaOk = await isBaaInForce(deps.baa, {
    organizationId: job.organizationId,
    contractReference: client.baaContractReference,
    asOf: at.toISOString(),
  });
  if (!baaOk) throw new BulkExportRefused("no BAA is in force for the requesting client");
  if (job.requestKind === "group") {
    throw new BulkExportRefused(
      "Group export is not supported: no Group membership source is available",
    );
  }
  for (const type of job.resourceTypes) {
    if (servedResource(type) === undefined || !supportsInteraction(type, "search-type")) {
      throw new BulkExportRefused(`resource type ${type} is not served by this gateway`);
    }
    if (!hasReadScope(client.allowedScopes, type)) {
      throw new BulkExportRefused(`scope system/${type}.read is no longer held by the client`);
    }
  }
}

interface Collected {
  readonly byType: ReadonlyMap<string, readonly unknown[]>;
  readonly outcomes: readonly OperationOutcome[];
  readonly total: number;
}

const paramsFor = (type: string, patientId: string, since: string): FhirSearchParams =>
  type === "Patient"
    ? { _id: patientId }
    : { patient: patientId, _since: since, _count: PER_PATIENT_RESOURCE_LIMIT };

/** Yield the job's patient ids: the explicit list (in pages) or M5's keyset enumeration. */
async function* patientIdPages(
  deps: BulkExportWorkerDeps,
  job: ExportJobRecord,
): AsyncGenerator<readonly string[]> {
  if (job.patientIds !== null) {
    for (let i = 0; i < job.patientIds.length; i += EXPORT_PATIENT_PAGE_SIZE) {
      yield job.patientIds.slice(i, i + EXPORT_PATIENT_PAGE_SIZE);
    }
    return;
  }
  let after: string | null = null;
  for (;;) {
    const page: readonly string[] = await deps.patients.patientIdsPage(
      job.organizationId,
      after,
      EXPORT_PATIENT_PAGE_SIZE,
    );
    if (page.length === 0) return;
    yield page;
    after = page[page.length - 1] ?? null;
    if (page.length < EXPORT_PATIENT_PAGE_SIZE) return;
  }
}

/** Step 3. Returns null when the job was cancelled while projecting. */
async function collectResources(
  deps: BulkExportWorkerDeps,
  job: ExportJobRecord,
  ctx: FhirProjectionContext,
): Promise<Collected | null> {
  const project = deps.project ?? projectSearch;
  const since = job.since?.toISOString() ?? EPOCH_ISO;
  const byType = new Map<string, unknown[]>();
  const seenAdvisories = new Set<string>();
  const outcomes: OperationOutcome[] = [];
  const unavailable = new Set<string>();
  let total = 0;

  const note = (outcome: OperationOutcome): void => {
    const text = outcome.issue[0]?.details?.text ?? JSON.stringify(outcome.issue);
    if (seenAdvisories.has(text)) return;
    seenAdvisories.add(text);
    outcomes.push(outcome);
  };

  for await (const page of patientIdPages(deps, job)) {
    if ((await exportJobStatus(deps.db, job.organizationId, job.id)) !== "in_progress") return null;
    for (const patientId of page) {
      for (const type of job.resourceTypes) {
        if (unavailable.has(type)) continue;
        let result: FhirProjectionResult | null;
        try {
          result = await project(ctx, type, paramsFor(type, patientId, since));
        } catch (error) {
          if (!unboundSeam(error)) throw error;
          unavailable.add(type);
          note(unavailableOutcome(type));
          continue;
        }
        if (result === null) continue;
        for (const warning of result.warnings) note(warning);
        if (result.resources.length === 0) continue;
        total += result.resources.length;
        if (total > EXPORT_MAX_RESOURCES_PER_JOB) {
          throw new BulkExportRefused(
            `the export exceeds ${EXPORT_MAX_RESOURCES_PER_JOB} resources; narrow _type or _since`,
          );
        }
        const bucket = byType.get(type) ?? [];
        for (const resource of result.resources) bucket.push(resource);
        byType.set(type, bucket);
      }
    }
  }
  return { byType, outcomes, total };
}

const toRecord = (plan: BulkExportArtifactPlan): ExportArtifactRecord => ({
  resourceType: plan.resourceType,
  objectKey: plan.objectKey,
  byteSize: Buffer.byteLength(plan.ndjson, "utf8"),
  rowCount: plan.rowCount,
  checksumSha256: plan.checksumSha256,
});

/** Step 4a: put every planned object; returns the keys written so far even when one put throws. */
async function putAll(
  deps: BulkExportWorkerDeps,
  organizationId: string,
  plans: readonly BulkExportArtifactPlan[],
  written: string[],
): Promise<void> {
  for (const plan of plans) {
    // Recorded BEFORE the put: a put that errors after the bytes landed (a timeout on the response) must
    // still be destroyed by the caller's clean-up. Destroying an absent object is a no-op.
    written.push(plan.objectKey);
    const { sha256Hex } = await deps.objects.put({
      organizationId,
      objectKey: plan.objectKey,
      bytes: Buffer.from(plan.ndjson, "utf8"),
    });
    if (sha256Hex !== plan.checksumSha256) {
      throw new Error(`object store checksum mismatch for ${plan.resourceType}`);
    }
  }
}

async function destroyAll(
  deps: BulkExportWorkerDeps,
  organizationId: string,
  keys: readonly string[],
): Promise<void> {
  for (const objectKey of keys) {
    try {
      await deps.objects.destroy({ organizationId, objectKey });
    } catch (error) {
      deps.log?.error({ err: error, objectKey }, "M28 bulk export: could not destroy an object");
    }
  }
}

const publishInTx =
  (deps: BulkExportWorkerDeps, organizationId: string, jobId: string) =>
  async (tx: DbClient, event: ExportOutboxEvent): Promise<void> => {
    await deps.outbox.publish(tx, {
      eventName: event.eventName,
      payload: event.payload,
      organizationId,
      aggregateKind: "fhir_bulk_export_job",
      aggregateId: jobId,
    });
  };

/** Step 4b: commit. Returns false when the job was cancelled in the meantime. */
async function commit(
  deps: BulkExportWorkerDeps,
  job: ExportJobRecord,
  collected: Collected,
  at: Date,
  written: string[],
): Promise<{ readonly done: boolean; readonly records: readonly ExportArtifactRecord[] }> {
  const dataPlans = [...collected.byType.entries()].map(([type, resources]) =>
    planBulkExportArtifact(job.organizationId, job.id as FhirBulkExportJobId, type, resources),
  );
  const outcomePlans =
    collected.outcomes.length > 0
      ? [
          planBulkExportArtifact(
            job.organizationId,
            job.id as FhirBulkExportJobId,
            OUTCOME_TYPE,
            collected.outcomes,
          ),
        ]
      : [];
  const plans = [...dataPlans, ...outcomePlans];
  await putAll(deps, job.organizationId, plans, written);
  const completion = computeBulkExportCompletion(dataPlans, at.getTime());
  const records = plans.map(toRecord);
  const event = bulkExportCompletedEvent({
    jobId: job.id as FhirBulkExportJobId,
    clientId: job.clientId as FhirClientId,
    completedAt: at.toISOString(),
    totalResources: completion.totalResources,
    artifactCount: records.length,
  });
  const done = await completeExportJob(
    deps.db,
    job.organizationId,
    {
      jobId: job.id,
      artifacts: records,
      completedAt: at,
      expiresAt: new Date(completion.expiresAtMs),
      totalResources: completion.totalResources,
      artifactCount: records.length,
      event: { eventName: event.type, payload: event.payload },
    },
    publishInTx(deps, job.organizationId, job.id),
  );
  return { done, records };
}

/** §164.528 — one accounting row per resource type, at completion, with the breakdown (W-FHIR-04 "Done means"). */
async function recordDisclosures(
  deps: BulkExportWorkerDeps,
  job: ExportJobRecord,
  records: readonly ExportArtifactRecord[],
  servedAt: Date,
): Promise<void> {
  if (deps.disclosures === undefined) {
    deps.log?.error(
      { jobId: job.id, organizationId: job.organizationId },
      "M28 §164.528: a bulk export completed with no disclosure sink bound; nothing was accounted",
    );
    return;
  }
  for (const record of records.filter((r) => r.resourceType !== OUTCOME_TYPE)) {
    try {
      await deps.disclosures.recordDisclosure({
        organizationId: job.organizationId as never,
        fhirClientId: job.clientId as never,
        resourceType: record.resourceType,
        queryParameters: {
          $export: job.id,
          ...(job.since ? { _since: job.since.toISOString() } : {}),
        },
        resultCount: record.rowCount,
        servedAt: servedAt.toISOString() as never,
        ...(job.initiatedByMembershipId
          ? { initiatedByMembershipId: job.initiatedByMembershipId as never }
          : {}),
      });
    } catch (error) {
      deps.log?.error(
        { err: error, jobId: job.id, resourceType: record.resourceType },
        "M28 §164.528: a bulk export disclosure could not be written to the ledger",
      );
    }
  }
}

async function failJob(
  deps: BulkExportWorkerDeps,
  job: ExportJobRecord,
  reason: string,
  at: Date,
): Promise<void> {
  const event = bulkExportFailedEvent({
    jobId: job.id as FhirBulkExportJobId,
    clientId: job.clientId as FhirClientId,
    failedAt: at.toISOString(),
    failureReason: reason,
  });
  await failExportJob(
    deps.db,
    job.organizationId,
    job.id,
    reason,
    { eventName: event.type, payload: event.payload },
    publishInTx(deps, job.organizationId, job.id),
  );
}

/** Steps 2-4 for a claimed job. Throws on failure; the caller owns the fail-and-clean-up path. */
async function execute(
  deps: BulkExportWorkerDeps,
  job: ExportJobRecord,
  at: Date,
  written: string[],
): Promise<BulkExportOutcome> {
  await assertExportAllowed(deps, job, at);
  const config = await loadExportConfig(deps.db, job.organizationId);
  const fallbackBase = `urn:wardenx:org:${job.organizationId}`;
  const ctx: FhirProjectionContext = {
    organizationId: job.organizationId,
    recipientClientId: job.clientId,
    tenantFhirHost: config?.tenantFhirHost ?? fallbackBase,
    identifierUriBase: config?.identifierUriBase ?? fallbackBase,
    asOfDate: at.toISOString(),
  };
  // Some owner-module seams resolve the tenant from the ambient request context; a worker has none, so it
  // enters one for THIS org with the system actor (the worker is not a request and acts for no human).
  const collected = await runWithRequestContext(
    { organizationId: job.organizationId, userId: SYSTEM_USER_ID, systemActor: true },
    () => collectResources(deps, job, ctx),
  );
  if (collected === null) return { status: "cancelled" };
  const { done, records } = await commit(deps, job, collected, at, written);
  // A cancel observed at commit: the caller destroys `written` (every cancelled outcome does).
  if (!done) return { status: "cancelled" };
  await recordDisclosures(deps, job, records, at);
  return { status: "completed", totalResources: collected.total, artifacts: records.length };
}

/** Run ONE export job for ONE org. Idempotent: a job that is not `accepted` is skipped. */
export async function runBulkExportJob(
  deps: BulkExportWorkerDeps,
  input: { readonly organizationId: string; readonly jobId: string },
): Promise<BulkExportOutcome> {
  const at = (deps.now ?? (() => new Date()))();
  const job = await claimExportJob(deps.db, input.organizationId, input.jobId, at);
  if (job === null) return { status: "skipped" };
  const written: string[] = [];
  try {
    const outcome = await execute(deps, job, at, written);
    if (outcome.status === "cancelled") await destroyAll(deps, job.organizationId, written);
    return outcome;
  } catch (error) {
    deps.log?.error(
      { err: error, jobId: job.id, organizationId: job.organizationId },
      "M28 bulk export failed",
    );
    await destroyAll(deps, job.organizationId, written);
    const reason = error instanceof BulkExportRefused ? error.message : GENERIC_FAILURE_REASON;
    await failJob(deps, job, reason, at);
    return { status: "failed", reason };
  }
}
