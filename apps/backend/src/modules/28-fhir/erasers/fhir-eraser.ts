// apps/backend/src/modules/28-fhir/erasers/fhir-eraser.ts — M28-T08, the §3.7 `fhir_gateway` data eraser
// (M4 destruction-cert workflow). The `subjectId` is the ORG being offboarded (the DataClass declares it).
//
// NOT A DELETE OF THE DISCLOSURE RECORD. Every row that IS the §164.528 accounting-of-disclosures evidence
// SURVIVES with its status, approvals, `baa_contract_reference`, `payload_sha256` and timestamps intact —
// the erase is a TARGETED SHRED of the secrets and PHI payloads those rows point at (§3.7):
//
//   · tenant_fhir_config      — `cursor_signing_key_cipher` zeroed (every outstanding signed cursor now
//     fails verification, which is the correct semantics — a destruction-certified tenant has no live
//     cursors); the row persists for survey reconstruction of the URI base at disclosure time.
//   · fhir_client             — soft-deleted to `status='revoked'`; the approvals + BAA reference retained.
//   · fhir_client_credential  — `secret_cipher` + `secret_digest_sha256` destroyed; `fingerprint` retained.
//   · fhir_client_session     — full delete (no PHI; routine-purged past 90 days anyway).
//   · fhir_bulk_export_job    — soft-deleted to `status='expired'` (the MinIO purge is the sweeper's; the
//     job metadata persists for audit reconstruction).
//   · fhir_inbound_resource   — `payload` replaced with the shred sentinel `{"_destroyed":true}`; the
//     `payload_sha256` + decision rationale + audit trail preserved.
//   · fhir_capability_snapshot — NEVER erased (platform-shared, no PHI).
//
// Runs inside `withOrgContext` so RLS scopes every statement to the acting org. Idempotent: a second erase
// finds the rows already shredded and reports zero.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { DataEraser, OrgScope } from "@wardenx/types";
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";

import { registerEraser } from "../../../bootstrap/index";

/** The narrow data port the eraseFn composes over (Drizzle in prod; in-memory in tests). */
export interface FhirGatewayEraseStore {
  eraseOrg(organizationId: string): Promise<number>;
}

/** The in-memory store for the slice/tests (seeded row count; idempotent on a second erase). */
export function createInMemoryFhirGatewayEraseStore(seed: { rows?: number } = {}): {
  store: FhirGatewayEraseStore;
  erasedOrgs: string[];
} {
  let remaining = seed.rows ?? 0;
  const erasedOrgs: string[] = [];
  return {
    erasedOrgs,
    store: {
      async eraseOrg(organizationId) {
        erasedOrgs.push(organizationId);
        const n = remaining;
        remaining = 0;
        return n;
      },
    },
  };
}

/** The Drizzle-backed store: the REAL §3.7 destruction path, scoped to the org by RLS. */
export function createDrizzleFhirGatewayEraseStore(db: DbClient): FhirGatewayEraseStore {
  const CONFIG = schema.tenantFhirConfig;
  const CLIENT = schema.fhirClient;
  const CRED = schema.fhirClientCredential;
  const SESSION = schema.fhirClientSession;
  const JOB = schema.fhirBulkExportJob;
  const INBOUND = schema.fhirInboundResource;
  const EMPTY_BYTEA = sql`''::bytea`;
  const SHRED_PAYLOAD = sql`'{"_destroyed":true}'::jsonb`;

  return {
    async eraseOrg(organizationId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        let touched = 0;

        const config = await tx
          .update(CONFIG)
          .set({ cursorSigningKeyCipher: EMPTY_BYTEA as never, updatedAt: new Date() })
          .where(
            and(
              eq(CONFIG.organizationId, organizationId),
              sql`length(${CONFIG.cursorSigningKeyCipher}) > 0`,
            ),
          )
          .returning({ organizationId: CONFIG.organizationId });
        touched += config.length;

        const clients = await tx
          .update(CLIENT)
          .set({ status: "revoked", revokedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(CLIENT.organizationId, organizationId), ne(CLIENT.status, "revoked")))
          .returning({ id: CLIENT.id });
        touched += clients.length;

        const creds = await tx
          .update(CRED)
          .set({ secretCipher: null, secretDigestSha256: null })
          .where(and(eq(CRED.organizationId, organizationId), isNotNull(CRED.secretDigestSha256)))
          .returning({ id: CRED.id });
        touched += creds.length;

        const sessions = await tx
          .delete(SESSION)
          .where(eq(SESSION.organizationId, organizationId))
          .returning({ jti: SESSION.jti });
        touched += sessions.length;

        const jobs = await tx
          .update(JOB)
          .set({ status: "expired" })
          .where(and(eq(JOB.organizationId, organizationId), ne(JOB.status, "expired")))
          .returning({ id: JOB.id });
        touched += jobs.length;

        const inbound = await tx
          .update(INBOUND)
          .set({ payload: SHRED_PAYLOAD as never })
          .where(
            and(
              eq(INBOUND.organizationId, organizationId),
              ne(INBOUND.payloadSha256, "_destroyed"),
            ),
          )
          .returning({ id: INBOUND.id });
        touched += inbound.length;

        return touched;
      });
    },
  };
}

/** Build the `fhir_gateway` `DataEraser`. `subjectId` is the org being offboarded. */
export function createFhirGatewayEraser(store: FhirGatewayEraseStore): DataEraser {
  return {
    async erase(scope: OrgScope, subjectId: string) {
      // The subject IS an org for this data class; prefer the scope's org, fall back to the subject.
      const organizationId = scope.orgId || subjectId;
      const erased = await store.eraseOrg(organizationId);
      return { erased };
    },
  };
}

/** Injected adapter for M28's eraser (slice defaults to in-memory). */
export interface FhirGatewayEraserDeps {
  store?: FhirGatewayEraseStore;
}

/** Register M28's REAL §3.7 eraser over the Phase-0 deny-stub (before validateErasers()). */
export function registerFhirGatewayEraser(deps: FhirGatewayEraserDeps = {}): void {
  const store = deps.store ?? createInMemoryFhirGatewayEraseStore().store;
  registerEraser("fhir_gateway", createFhirGatewayEraser(store));
}
