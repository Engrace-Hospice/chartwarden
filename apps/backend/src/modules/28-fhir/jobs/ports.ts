// apps/backend/src/modules/28-fhir/jobs/ports.ts — the narrow ports the M28 workers run over (GAP-084).
//
// Each is bound at the composition root (apps/backend/src/index.ts): M28 imports no other module's code or
// schema (architecture §25.15), and the object store is M22's adapter, so M28 declares the slice it needs.
import type { FhirReadDisclosureEnvelope } from "@wardenx/types";

/** The active-org fan-out (`buildActiveOrgEnumerator` over the audited platform pool). */
export interface ActiveOrgListPort {
  listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
}

/**
 * The MinIO/S3 slice the export worker + sweeper need. The adapter scopes every call to the tenant's own
 * bucket (`tenant-<organizationId>`), so a key can never address another tenant's objects even if a caller
 * built a wrong one — the org id is an argument to every method for exactly that reason.
 */
export interface FhirExportObjectStore {
  /** Write one NDJSON object; returns the sha256 (hex) the store verified. */
  put(args: {
    readonly organizationId: string;
    readonly objectKey: string;
    readonly bytes: Uint8Array;
  }): Promise<{ readonly sha256Hex: string }>;
  /** A short-TTL presigned GET URL for one object. The URL is never logged. */
  presignGet(args: {
    readonly organizationId: string;
    readonly objectKey: string;
    readonly ttlSeconds: number;
  }): Promise<{ readonly url: string; readonly expiresAt: string }>;
  /** Destroy every version of the object. Idempotent: an absent object is success. */
  destroy(args: { readonly organizationId: string; readonly objectKey: string }): Promise<void>;
}

/** M5's keyset patient-id enumeration (`patientIdsPageForOrg`), injected so M28 reads no M5 table. */
export interface ExportPatientEnumeratorPort {
  patientIdsPage(
    organizationId: string,
    afterId: string | null,
    limit: number,
  ): Promise<readonly string[]>;
}

/** The producer side of the `fhir.bulk-export` queue. A failed enqueue is recoverable (the sweeper re-queues). */
export interface BulkExportEnqueuePort {
  enqueue(organizationId: string, jobId: string): Promise<void>;
}

/** The M36 alert emit (best-effort; the outbox event is the contract, the alert is the notification). */
export interface FhirAlertPort {
  emit(input: {
    readonly organizationId: string;
    readonly kind: string;
    readonly payload: Record<string, unknown>;
    readonly correlationId: string;
  }): Promise<void>;
}

/** The §164.528 accounting sink (the `fhir_read_disclosure` ledger). */
export interface FhirDisclosureSink {
  recordDisclosure(envelope: FhirReadDisclosureEnvelope): Promise<void>;
}

/** The catalog-validating tx outbox publisher with `callerModule` pinned to `m28`. */
export interface FhirJobOutboxPort {
  publish(
    tx: unknown,
    input: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

/** BAA gate — the same fail-closed M40 view the request path uses. */
export interface FhirJobBaaPort {
  isBaaActive(input: {
    organizationId: string;
    contractReference: string;
    asOf: string;
  }): Promise<boolean>;
}
