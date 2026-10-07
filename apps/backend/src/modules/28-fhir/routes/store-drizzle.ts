// apps/backend/src/modules/28-fhir/routes/store-drizzle.ts — M28-T08 the PRODUCTION FhirGatewayStore.
//
// The Drizzle-backed repo the §4.1 routes run against. Every org-scoped statement opens `withOrgContext`
// so RLS scopes it to the acting org and the M4 write-audit trigger stamps the acting USER (inherited from
// the ambient request; see `ctx` below — never the membership id, which is not a "user" FK target). The revocation cascade
// (W-FHIR-12) runs INSIDE the same transaction as the status write, so a client cannot be left `revoked`
// with a live session.
//
// PHASE-1 CRYPTO POSTURE. No module on this platform binds a per-tenant DEK envelope yet, so a rotated
// `api_key` secret is stored as its sha256 DIGEST (the constant-time match value) with a NULL
// `secret_cipher`; the plaintext is returned to the caller once and never persisted in the clear. The
// `tenant_fhir_config.cursor_signing_key_cipher` is NOT NULL, so it is seeded with freshly-generated key
// bytes — a real DEK wrap lands when the platform cipher does (the M32/M20 posture).
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { type DbClient, schema } from "@wardenx/db";
import {
  FHIR_CLIENT_CASCADE_ON_ENTRY,
  fhirClientTransition,
  fhirDualApprovalSatisfied,
  fhirInboundOwnerModuleFor,
  inboundPayloadSha256,
} from "@wardenx/fhir";
import { withOrgContext } from "@wardenx/tenancy";
import {
  FHIR_INBOUND_REJECT_RATIONALE_MIN_CHARS,
  type FhirBulkExportRequestKind,
  type FhirClientDetail,
  type FhirClientStatus,
  type FhirClientSummary,
  type FhirInboundOwnerModule,
  type FhirInboundStatus,
} from "@wardenx/types";
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";

import { INBOUND_PAYLOAD_RETENTION_DAYS } from "../jobs/queues";
import { type FhirRevocationCascadePort, cascadeClientRevocation } from "./revocation-cascade";
import {
  type CreateClientArgs,
  type FhirBearerContext,
  type FhirBulkExportArtifactView,
  type FhirBulkExportJobView,
  type FhirClientCreateResult,
  type FhirCredentialRotationResult,
  type FhirGatewayStore,
  type FhirInboundProposalView,
  type FhirSessionSummary,
  FhirStoreError,
  type FhirTenantConfigView,
  type FhirWriteOutboxPort,
  NOOP_FHIR_OUTBOX,
  type StageInboundArgs,
  activeJobError,
} from "./store";

/** The Drizzle transaction handle `withOrgContext` hands its callback (full query-builder surface). */
type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/** §2.2 — the rotation overlap in which a `retired` credential still authenticates (30 days). */
const FHIR_CREDENTIAL_ROTATION_OVERLAP_MS = 30 * 24 * 60 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Both tenant resolvers take a uuid, so a non-uuid is refused HERE rather than by Postgres. Not
 * cosmetic: `$1::uuid` on a garbage string raises `22P02`, which surfaces as a 500 on a route whose
 * honest answer is 401, and lets an unauthenticated caller distinguish "malformed" from "unknown" by
 * status code — a free oracle on a credential-shaped input.
 */
const isUuid = (value: string): boolean => UUID_RE.test(value);

export interface FhirGatewayStoreDeps {
  readonly outbox?: FhirWriteOutboxPort;
}

export function createDrizzleFhirGatewayStore(
  db: DbClient,
  deps: FhirGatewayStoreDeps = {},
): FhirGatewayStore {
  const outbox = deps.outbox ?? NOOP_FHIR_OUTBOX;
  const CLIENT = schema.fhirClient;
  const CRED = schema.fhirClientCredential;
  const SESSION = schema.fhirClientSession;
  const JOB = schema.fhirBulkExportJob;
  const ARTIFACT = schema.fhirBulkExportArtifact;
  const INBOUND = schema.fhirInboundResource;
  const CONFIG = schema.tenantFhirConfig;
  const DISCLOSURE = schema.fhirReadDisclosure;

  // The audit actor is NEVER a membership id: the M4 write-audit trigger FKs `app.user_id` to "user", so a
  // membership uuid fails every audited admin write (accept/reject/cancel/revoke/...). `userId: ""` inherits
  // the ambient authenticated request's real user id (same org, uuid) and records the NULL system actor
  // outside a request — both valid. The accountable MEMBERSHIP is still stamped on the row itself
  // (`decided_by_membership_id`, `approved_by_*`, `initiated_by_membership_id`).
  const ctx = (orgId: string) => ({
    organizationId: orgId,
    userId: "",
  });

  /**
   * The two tenant resolvers (migration 0233). Each takes ONE unguessable uuid the caller must already
   * hold and returns ONE org uuid — nothing else, and nothing an attacker without the credential can
   * use. They exist because the FHIR-spec surface is the one place on this platform where the tenant is
   * a fact about the CREDENTIAL rather than about a session, so it must be read before an org context
   * can be opened. A null answer is "no such credential", which every caller turns into a 401.
   */
  const resolveOrgVia = async (fn: string, arg: string): Promise<string | null> => {
    try {
      const { rows } = await db.execute(
        sql`SELECT ${sql.raw(fn)}(${arg}::uuid) AS organization_id`,
      );
      const org = (rows as Record<string, unknown>[])[0]?.organization_id;
      return typeof org === "string" && org.length > 0 ? org : null;
    } catch {
      return null;
    }
  };
  const resolveSessionOrg = (jti: string) => resolveOrgVia("fhir_resolve_session_org", jti);
  const resolveClientOrg = (clientId: string) => resolveOrgVia("fhir_resolve_client_org", clientId);

  const clientDetailRow = (
    row: typeof CLIENT.$inferSelect,
    activeSessionCount: number,
  ): FhirClientDetail => ({
    id: row.id,
    name: row.name,
    type: row.type,
    tier: row.tier,
    status: row.status,
    baaContractReference: row.baaContractReference,
    approvedAt: iso(row.approvedAt),
    createdAt: row.createdAt.toISOString(),
    allowedScopes: asStringArray(row.allowedScopes),
    rateLimitRps: row.rateLimitRps,
    ipAllowlist: asStringArray(row.ipAllowlist),
    jwksUri: row.jwksUri,
    fingerprint: null,
    lastSuccessfulRequestAt: null,
    activeSessionCount,
  });

  const summaryRow = (row: typeof CLIENT.$inferSelect): FhirClientSummary => ({
    id: row.id,
    name: row.name,
    type: row.type,
    tier: row.tier,
    status: row.status,
    baaContractReference: row.baaContractReference,
    approvedAt: iso(row.approvedAt),
    createdAt: row.createdAt.toISOString(),
  });

  const jobView = (row: typeof JOB.$inferSelect): FhirBulkExportJobView => ({
    id: row.id,
    clientId: row.clientId,
    requestKind: row.requestKind,
    resourceTypes: asStringArray(row.resourceTypes),
    status: row.status,
    initiatedByMembershipId: row.initiatedByMembershipId,
    createdAt: row.createdAt.toISOString(),
    completedAt: iso(row.completedAt),
    expiresAt: iso(row.expiresAt),
  });

  const proposalView = (row: typeof INBOUND.$inferSelect): FhirInboundProposalView => ({
    id: row.id,
    resourceType: row.resourceType,
    sourceClientId: row.sourceClientId,
    sourceFhirId: row.sourceFhirId,
    ownerModule: row.ownerModule as FhirInboundOwnerModule,
    proposalStatus: row.proposalStatus as FhirInboundStatus,
    payloadSha256: row.payloadSha256,
    proposedAt: row.proposedAt.toISOString(),
    decidedByMembershipId: row.decidedByMembershipId,
    decidedAt: iso(row.decidedAt),
    decisionRationale: row.decisionRationale,
    acceptedAggregateId: row.acceptedAggregateId,
  });

  const configView = (row: typeof CONFIG.$inferSelect): FhirTenantConfigView => ({
    organizationId: row.organizationId,
    tenantFhirHost: row.tenantFhirHost,
    identifierUriBase: row.identifierUriBase,
    inboundReviewSlaHours: row.inboundReviewSlaHours,
    exportDedupWindowMinutes: row.exportDedupWindowMinutes,
    cursorKeyFingerprint: createHash("sha256")
      .update(row.cursorSigningKeyCipher)
      .digest("hex")
      .slice(0, 8),
  });

  const activeSessionCount = async (tx: Tx, orgId: string, clientId: string): Promise<number> => {
    const rows = await tx
      .select({ jti: SESSION.jti })
      .from(SESSION)
      .where(
        and(
          eq(SESSION.organizationId, orgId),
          eq(SESSION.clientId, clientId),
          isNull(SESSION.revokedAt),
          gt(SESSION.expiresAt, new Date()),
        ),
      );
    return rows.length;
  };

  const cascadePortIn = (tx: Tx): FhirRevocationCascadePort => ({
    async activeSessionJtisForClient(orgId, clientId) {
      const rows = await tx
        .select({ jti: SESSION.jti })
        .from(SESSION)
        .where(
          and(
            eq(SESSION.organizationId, orgId),
            eq(SESSION.clientId, clientId),
            isNull(SESSION.revokedAt),
            gt(SESSION.expiresAt, new Date()),
          ),
        );
      return rows.map((r) => r.jti);
    },
    async revokeSession(orgId, clientId, jti) {
      await tx
        .update(SESSION)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(SESSION.jti, jti),
            eq(SESSION.organizationId, orgId),
            eq(SESSION.clientId, clientId),
          ),
        );
    },
    async inflightJobIdsForClient(orgId, clientId) {
      const rows = await tx
        .select({ id: JOB.id })
        .from(JOB)
        .where(
          and(
            eq(JOB.organizationId, orgId),
            eq(JOB.clientId, clientId),
            inArray(JOB.status, ["accepted", "in_progress"]),
          ),
        );
      return rows.map((r) => r.id);
    },
    async cancelJob(orgId, jobId) {
      const [row] = await tx
        .update(JOB)
        .set({ status: "cancelled" })
        .where(and(eq(JOB.id, jobId), eq(JOB.organizationId, orgId)))
        .returning({ clientId: JOB.clientId });
      if (row) {
        await outbox.publish(tx, {
          eventName: "m28.fhir.bulk_export.cancelled",
          payload: {
            jobId,
            clientId: row.clientId,
            cancelledByMembershipId: null,
            cancelledAt: new Date().toISOString(),
          },
          organizationId: orgId,
          aggregateKind: "fhir_bulk_export_job",
          aggregateId: jobId,
        });
      }
    },
  });

  const loadClientTx = async (tx: Tx, orgId: string, clientId: string) => {
    const [row] = await tx
      .select()
      .from(CLIENT)
      .where(and(eq(CLIENT.id, clientId), eq(CLIENT.organizationId, orgId)))
      .limit(1);
    if (!row) throw new FhirStoreError(404, "FHIR_CLIENT_NOT_FOUND", "fhir_client not found");
    return row;
  };

  const enterStatus = async (
    tx: Tx,
    orgId: string,
    row: typeof CLIENT.$inferSelect,
    to: FhirClientStatus,
    patch: Partial<typeof CLIENT.$inferInsert>,
  ) => {
    if (fhirClientTransition(row.status, to) === null) {
      throw new FhirStoreError(
        409,
        "FHIR_CLIENT_ILLEGAL_TRANSITION",
        `cannot transition fhir_client from ${row.status} to ${to}`,
      );
    }
    await tx
      .update(CLIENT)
      .set({ status: to, updatedAt: new Date(), ...patch })
      .where(and(eq(CLIENT.id, row.id), eq(CLIENT.organizationId, orgId)));
    if (FHIR_CLIENT_CASCADE_ON_ENTRY.includes(to)) {
      return cascadeClientRevocation(orgId, row.id, cascadePortIn(tx));
    }
    return { sessionsRevoked: 0, jobsCancelled: 0 };
  };

  return {
    async listClients(orgId, filters) {
      return withOrgContext(db, ctx(orgId), async (tx) => {
        const where = filters.status
          ? and(eq(CLIENT.organizationId, orgId), eq(CLIENT.status, filters.status))
          : eq(CLIENT.organizationId, orgId);
        const rows = await tx.select().from(CLIENT).where(where).orderBy(desc(CLIENT.createdAt));
        return rows.map(summaryRow);
      });
    },

    async createClient(orgId, args): Promise<FhirClientCreateResult> {
      return withOrgContext(db, ctx(orgId), async (tx) => {
        const [row] = await tx
          .insert(CLIENT)
          .values({
            organizationId: orgId,
            name: args.name,
            type: args.type,
            jwksUri: args.jwksUri ?? null,
            allowedScopes: [...args.allowedScopes],
            tier: args.tier,
            rateLimitRps: args.rateLimitRps,
            ipAllowlist: [...args.ipAllowlist],
            baaContractReference: args.baaContractReference,
            status: "pending_approval",
            approvedByAdminMembershipId: args.proposedByMembershipId,
          })
          .returning();
        const client = row!;
        let plaintextSecret: string | null = null;
        if (args.type === "api_key") {
          plaintextSecret = randomBytes(32).toString("hex");
          const digest = createHash("sha256").update(plaintextSecret).digest("hex");
          await tx.insert(CRED).values({
            organizationId: orgId,
            clientId: client.id,
            kind: "api_key",
            secretCipher: null,
            secretDigestSha256: digest,
            fingerprint: plaintextSecret.slice(0, 8),
            status: "active",
          });
        }
        await outbox.publish(tx, {
          eventName: "m28.fhir.client.pending_approval",
          payload: {
            clientId: client.id,
            proposedByMembershipId: args.proposedByMembershipId,
            tier: args.tier,
            allowedScopes: [...args.allowedScopes],
          },
          organizationId: orgId,
          aggregateKind: "fhir_client",
          aggregateId: client.id,
        });
        return { client: clientDetailRow(client, 0), plaintextSecret };
      });
    },

    async getClient(orgId, clientId) {
      return withOrgContext(db, ctx(orgId), async (tx) => {
        const [row] = await tx
          .select()
          .from(CLIENT)
          .where(and(eq(CLIENT.id, clientId), eq(CLIENT.organizationId, orgId)))
          .limit(1);
        if (!row) return null;
        return clientDetailRow(row, await activeSessionCount(tx, orgId, clientId));
      });
    },

    async approveClient(orgId, clientId, complianceMembershipId, _rationale) {
      return withOrgContext(db, ctx(orgId), async (tx) => {
        const row = await loadClientTx(tx, orgId, clientId);
        if (!fhirDualApprovalSatisfied(row.approvedByAdminMembershipId, complianceMembershipId)) {
          throw new FhirStoreError(
            409,
            "FHIR_CLIENT_DUAL_APPROVAL_REQUIRED",
            "a fhir_client requires two DISTINCT approvers; self-approval is refused",
          );
        }
        await enterStatus(tx, orgId, row, "active", {
          approvedByComplianceMembershipId: complianceMembershipId,
          approvedAt: new Date(),
        });
        await outbox.publish(tx, {
          eventName: "m28.fhir.client.activated",
          payload: {
            clientId,
            approvedByAdminMembershipId: row.approvedByAdminMembershipId,
            approvedByComplianceMembershipId: complianceMembershipId,
            approvedAt: new Date().toISOString(),
          },
          organizationId: orgId,
          aggregateKind: "fhir_client",
          aggregateId: clientId,
        });
        const updated = await loadClientTx(tx, orgId, clientId);
        return clientDetailRow(updated, await activeSessionCount(tx, orgId, clientId));
      });
    },

    async revokeClient(orgId, clientId, membershipId, rationale) {
      return withOrgContext(db, ctx(orgId), async (tx) => {
        const row = await loadClientTx(tx, orgId, clientId);
        const cascade = await enterStatus(tx, orgId, row, "revoked", {
          revokedAt: new Date(),
          revokedReason: rationale,
        });
        await outbox.publish(tx, {
          eventName: "m28.fhir.client.revoked",
          payload: { clientId, revokedAt: new Date().toISOString(), rationale },
          organizationId: orgId,
          aggregateKind: "fhir_client",
          aggregateId: clientId,
        });
        const updated = await loadClientTx(tx, orgId, clientId);
        return { client: clientDetailRow(updated, 0), cascade };
      });
    },

    async suspendClient(orgId, clientId, membershipId, reason) {
      return withOrgContext(db, ctx(orgId), async (tx) => {
        const row = await loadClientTx(tx, orgId, clientId);
        const cascade = await enterStatus(tx, orgId, row, "suspended", {});
        await outbox.publish(tx, {
          eventName: "m28.fhir.client.suspended",
          payload: { clientId, reason },
          organizationId: orgId,
          aggregateKind: "fhir_client",
          aggregateId: clientId,
        });
        const updated = await loadClientTx(tx, orgId, clientId);
        return { client: clientDetailRow(updated, 0), cascade };
      });
    },

    async rotateCredential(orgId, clientId, membershipId): Promise<FhirCredentialRotationResult> {
      return withOrgContext(db, ctx(orgId), async (tx) => {
        await loadClientTx(tx, orgId, clientId);
        const plaintextSecret = randomBytes(32).toString("hex");
        const digest = createHash("sha256").update(plaintextSecret).digest("hex");
        const fingerprint = plaintextSecret.slice(0, 8);
        await tx
          .update(CRED)
          .set({ status: "retired", retiredAt: new Date() })
          .where(and(eq(CRED.clientId, clientId), eq(CRED.status, "active")));
        await tx.insert(CRED).values({
          organizationId: orgId,
          clientId,
          kind: "api_key",
          secretCipher: null,
          secretDigestSha256: digest,
          fingerprint,
          status: "active",
          rotatedAt: new Date(),
        });
        return { fingerprint, plaintextSecret };
      });
    },

    async listSessions(orgId, clientId): Promise<readonly FhirSessionSummary[]> {
      return withOrgContext(db, ctx(orgId), async (tx) => {
        const rows = await tx
          .select()
          .from(SESSION)
          .where(and(eq(SESSION.organizationId, orgId), eq(SESSION.clientId, clientId)))
          .orderBy(desc(SESSION.issuedAt));
        return rows.map((r) => ({
          jti: r.jti,
          clientId: r.clientId,
          scopesGranted: asStringArray(r.scopesGranted),
          issuedAt: r.issuedAt.toISOString(),
          expiresAt: r.expiresAt.toISOString(),
          revokedAt: iso(r.revokedAt),
        }));
      });
    },

    async revokeSession(orgId, clientId, jti) {
      return withOrgContext(db, ctx(orgId), async (tx) => {
        const res = await tx
          .update(SESSION)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(SESSION.jti, jti),
              eq(SESSION.organizationId, orgId),
              eq(SESSION.clientId, clientId),
            ),
          )
          .returning({ jti: SESSION.jti });
        if (res.length === 0) {
          throw new FhirStoreError(404, "FHIR_SESSION_NOT_FOUND", "fhir_client_session not found");
        }
      });
    },

    async listJobs(orgId, filters) {
      return withOrgContext(db, ctx(orgId), async (tx) => {
        const conds = [eq(JOB.organizationId, orgId)];
        if (filters.status) conds.push(eq(JOB.status, filters.status as never));
        if (filters.clientId) conds.push(eq(JOB.clientId, filters.clientId));
        const rows = await tx
          .select()
          .from(JOB)
          .where(and(...conds))
          .orderBy(desc(JOB.createdAt));
        return rows.map(jobView);
      });
    },

    async createJob(orgId, args) {
      const membershipId = args.initiatedByMembershipId ?? "";
      return withOrgContext(db, ctx(orgId), async (tx) => {
        // §2.5: one active job per client. The advisory lock serialises concurrent submissions for the SAME
        // client for the life of this tx, so the check below and the insert cannot interleave (a partial
        // unique index would be the other way, but pre-existing never-run `accepted` rows would block it).
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`fhir-export:${args.clientId}`}))`,
        );
        const [active] = await tx
          .select({ id: JOB.id })
          .from(JOB)
          .where(
            and(
              eq(JOB.organizationId, orgId),
              eq(JOB.clientId, args.clientId),
              inArray(JOB.status, ["accepted", "in_progress"]),
            ),
          )
          .limit(1);
        if (active) throw activeJobError();
        const envelope = JSON.stringify({
          clientId: args.clientId,
          requestKind: args.requestKind,
          groupId: args.groupId ?? null,
          patientIds: args.patientIds ?? null,
          resourceTypes: [...args.resourceTypes].sort(),
          since: args.since ?? null,
        });
        const [row] = await tx
          .insert(JOB)
          .values({
            organizationId: orgId,
            clientId: args.clientId,
            requestKind: args.requestKind,
            groupId: args.groupId ?? null,
            patientIds: args.patientIds ? [...args.patientIds] : null,
            resourceTypes: [...args.resourceTypes],
            sinceIso: args.since ? new Date(args.since) : null,
            requestEnvelopeSha256: createHash("sha256").update(envelope).digest("hex"),
            status: "accepted",
            initiatedByMembershipId: args.initiatedByMembershipId,
          })
          .returning();
        const job = row!;
        await outbox.publish(tx, {
          eventName: "m28.fhir.bulk_export.accepted",
          payload: {
            jobId: job.id,
            clientId: args.clientId,
            resourceTypes: [...args.resourceTypes],
            requestKind: args.requestKind,
          },
          organizationId: orgId,
          aggregateKind: "fhir_bulk_export_job",
          aggregateId: job.id,
        });
        return jobView(job);
      });
    },

    async listJobArtifacts(orgId, jobId): Promise<readonly FhirBulkExportArtifactView[]> {
      return withOrgContext(db, ctx(orgId), async (tx) => {
        const rows = await tx
          .select()
          .from(ARTIFACT)
          .where(and(eq(ARTIFACT.jobId, jobId), eq(ARTIFACT.organizationId, orgId)))
          .orderBy(ARTIFACT.resourceType);
        return rows.map((r) => ({
          resourceType: r.resourceType,
          objectKey: r.minioObjectKey,
          byteSize: r.byteSize,
          rowCount: r.rowCount,
          checksumSha256: r.checksumSha256,
        }));
      });
    },

    async getJob(orgId, jobId) {
      return withOrgContext(db, ctx(orgId), async (tx) => {
        const [row] = await tx
          .select()
          .from(JOB)
          .where(and(eq(JOB.id, jobId), eq(JOB.organizationId, orgId)))
          .limit(1);
        return row ? jobView(row) : null;
      });
    },

    async cancelJob(orgId, jobId, membershipId) {
      return withOrgContext(db, ctx(orgId), async (tx) => {
        const [row] = await tx
          .select()
          .from(JOB)
          .where(and(eq(JOB.id, jobId), eq(JOB.organizationId, orgId)))
          .limit(1);
        if (!row) {
          throw new FhirStoreError(
            404,
            "FHIR_EXPORT_JOB_NOT_FOUND",
            "fhir_bulk_export_job not found",
          );
        }
        if (row.status === "accepted" || row.status === "in_progress") {
          await tx
            .update(JOB)
            .set({ status: "cancelled" })
            .where(and(eq(JOB.id, jobId), eq(JOB.organizationId, orgId)));
          await outbox.publish(tx, {
            eventName: "m28.fhir.bulk_export.cancelled",
            payload: {
              jobId,
              clientId: row.clientId,
              cancelledByMembershipId: membershipId ?? null,
              cancelledAt: new Date().toISOString(),
            },
            organizationId: orgId,
            aggregateKind: "fhir_bulk_export_job",
            aggregateId: jobId,
          });
        }
        const [updated] = await tx
          .select()
          .from(JOB)
          .where(and(eq(JOB.id, jobId), eq(JOB.organizationId, orgId)))
          .limit(1);
        return jobView(updated!);
      });
    },

    async listProposals(orgId, filters) {
      return withOrgContext(db, ctx(orgId), async (tx) => {
        const conds = [eq(INBOUND.organizationId, orgId)];
        if (filters.ownerModule) conds.push(eq(INBOUND.ownerModule, filters.ownerModule));
        if (filters.status) conds.push(eq(INBOUND.proposalStatus, filters.status));
        const rows = await tx
          .select()
          .from(INBOUND)
          .where(and(...conds))
          .orderBy(desc(INBOUND.proposedAt));
        return rows.map(proposalView);
      });
    },

    async getProposal(orgId, proposalId) {
      return withOrgContext(db, ctx(orgId), async (tx) => {
        const [row] = await tx
          .select()
          .from(INBOUND)
          .where(and(eq(INBOUND.id, proposalId), eq(INBOUND.organizationId, orgId)))
          .limit(1);
        return row ? proposalView(row) : null;
      });
    },

    async acceptProposal(orgId, proposalId, membershipId, acceptedAggregateId, rationale) {
      return withOrgContext(db, ctx(orgId), async (tx) => {
        const [row] = await tx
          .select()
          .from(INBOUND)
          .where(and(eq(INBOUND.id, proposalId), eq(INBOUND.organizationId, orgId)))
          .limit(1);
        if (!row)
          throw new FhirStoreError(
            404,
            "FHIR_PROPOSAL_NOT_FOUND",
            "fhir_inbound_resource not found",
          );
        if (row.proposalStatus !== "pending") {
          throw new FhirStoreError(409, "FHIR_PROPOSAL_DECIDED", "proposal already decided");
        }
        await tx
          .update(INBOUND)
          .set({
            proposalStatus: "accepted",
            decidedByMembershipId: membershipId,
            decidedAt: new Date(),
            decisionRationale: rationale,
            acceptedAggregateId,
          })
          .where(and(eq(INBOUND.id, proposalId), eq(INBOUND.organizationId, orgId)));
        await outbox.publish(tx, {
          eventName: "m28.fhir.inbound.accepted",
          payload: {
            proposalId,
            ownerModule: row.ownerModule,
            acceptedAggregateId,
            decidedByMembershipId: membershipId,
            decidedAt: new Date().toISOString(),
          },
          organizationId: orgId,
          aggregateKind: "fhir_inbound_resource",
          aggregateId: proposalId,
        });
        const [updated] = await tx
          .select()
          .from(INBOUND)
          .where(and(eq(INBOUND.id, proposalId), eq(INBOUND.organizationId, orgId)))
          .limit(1);
        return proposalView(updated!);
      });
    },

    async rejectProposal(orgId, proposalId, membershipId, rationale) {
      if (rationale.trim().length < FHIR_INBOUND_REJECT_RATIONALE_MIN_CHARS) {
        throw new FhirStoreError(
          422,
          "FHIR_PROPOSAL_RATIONALE_TOO_SHORT",
          `a rejection rationale must be at least ${FHIR_INBOUND_REJECT_RATIONALE_MIN_CHARS} characters`,
        );
      }
      return withOrgContext(db, ctx(orgId), async (tx) => {
        const [row] = await tx
          .select()
          .from(INBOUND)
          .where(and(eq(INBOUND.id, proposalId), eq(INBOUND.organizationId, orgId)))
          .limit(1);
        if (!row)
          throw new FhirStoreError(
            404,
            "FHIR_PROPOSAL_NOT_FOUND",
            "fhir_inbound_resource not found",
          );
        if (row.proposalStatus !== "pending") {
          throw new FhirStoreError(409, "FHIR_PROPOSAL_DECIDED", "proposal already decided");
        }
        await tx
          .update(INBOUND)
          .set({
            proposalStatus: "rejected",
            decidedByMembershipId: membershipId,
            decidedAt: new Date(),
            decisionRationale: rationale,
            // §2.2/§3.7 — the raw payload is shredded 30 days after a rejection (the destruction cron).
            payloadEraseScheduledAt: new Date(
              Date.now() + INBOUND_PAYLOAD_RETENTION_DAYS * 86_400_000,
            ),
          })
          .where(and(eq(INBOUND.id, proposalId), eq(INBOUND.organizationId, orgId)));
        await outbox.publish(tx, {
          eventName: "m28.fhir.inbound.rejected",
          payload: {
            proposalId,
            ownerModule: row.ownerModule,
            decidedByMembershipId: membershipId,
            decidedAt: new Date().toISOString(),
            rationale,
          },
          organizationId: orgId,
          aggregateKind: "fhir_inbound_resource",
          aggregateId: proposalId,
        });
        const [updated] = await tx
          .select()
          .from(INBOUND)
          .where(and(eq(INBOUND.id, proposalId), eq(INBOUND.organizationId, orgId)))
          .limit(1);
        return proposalView(updated!);
      });
    },

    async stageInbound(orgId, args: StageInboundArgs) {
      const ownerModule = fhirInboundOwnerModuleFor(args.resourceType);
      if (ownerModule === null) {
        throw new FhirStoreError(
          501,
          "FHIR_INBOUND_UNSUPPORTED",
          `no inbound owner module for resource type ${args.resourceType}`,
        );
      }
      return withOrgContext(db, ctx(orgId), async (tx) => {
        const [row] = await tx
          .insert(INBOUND)
          .values({
            organizationId: orgId,
            sourceClientId: args.sourceClientId,
            resourceType: args.resourceType,
            sourceFhirId: args.sourceFhirId,
            payload: args.payload,
            payloadSha256: inboundPayloadSha256(args.payload),
            ownerModule,
            proposalStatus: "pending",
          })
          .returning();
        const proposal = row!;
        await outbox.publish(tx, {
          eventName: "m28.fhir.inbound.proposed",
          payload: {
            proposalId: proposal.id,
            ownerModule,
            resourceType: args.resourceType,
            sourceClientId: args.sourceClientId,
            proposedAt: proposal.proposedAt.toISOString(),
            payloadSha256: proposal.payloadSha256,
          },
          organizationId: orgId,
          aggregateKind: "fhir_inbound_resource",
          aggregateId: proposal.id,
        });
        return proposalView(proposal);
      });
    },

    async getConfig(orgId) {
      return withOrgContext(db, ctx(orgId), async (tx) => {
        const [row] = await tx
          .select()
          .from(CONFIG)
          .where(eq(CONFIG.organizationId, orgId))
          .limit(1);
        return row ? configView(row) : null;
      });
    },

    async putConfig(orgId, args) {
      return withOrgContext(db, ctx(orgId), async (tx) => {
        const [existing] = await tx
          .select()
          .from(CONFIG)
          .where(eq(CONFIG.organizationId, orgId))
          .limit(1);
        const patch = {
          tenantFhirHost: args.tenantFhirHost,
          identifierUriBase: args.identifierUriBase,
          inboundReviewSlaHours:
            args.inboundReviewSlaHours ?? existing?.inboundReviewSlaHours ?? 72,
          exportDedupWindowMinutes:
            args.exportDedupWindowMinutes ?? existing?.exportDedupWindowMinutes ?? 10,
          updatedAt: new Date(),
        };
        if (existing) {
          await tx.update(CONFIG).set(patch).where(eq(CONFIG.organizationId, orgId));
        } else {
          await tx.insert(CONFIG).values({
            organizationId: orgId,
            cursorSigningKeyCipher: randomBytes(32),
            ...patch,
          });
        }
        const [row] = await tx
          .select()
          .from(CONFIG)
          .where(eq(CONFIG.organizationId, orgId))
          .limit(1);
        return configView(row!);
      });
    },

    async rotateCursorKey(orgId) {
      return withOrgContext(db, ctx(orgId), async (tx) => {
        const key = randomBytes(32);
        const res = await tx
          .update(CONFIG)
          .set({ cursorSigningKeyCipher: key, updatedAt: new Date() })
          .where(eq(CONFIG.organizationId, orgId))
          .returning({ organizationId: CONFIG.organizationId });
        if (res.length === 0) {
          throw new FhirStoreError(404, "FHIR_CONFIG_NOT_FOUND", "tenant_fhir_config not found");
        }
        return { fingerprint: createHash("sha256").update(key).digest("hex").slice(0, 8) };
      });
    },

    async resolveBearer(token): Promise<FhirBearerContext | null> {
      // The bearer token IS the session `jti`. The caller carries no WardenX session, so the tenant is
      // unknown here and has to be RESOLVED before any row can be read — `fhir_resolve_session_org`
      // (0233) is the narrow SECURITY DEFINER function that does it, taking one unguessable uuid and
      // returning one org uuid. Everything after this line runs inside `withOrgContext`, so the session
      // row and the client row are read under ordinary RLS with no bypass anywhere.
      //
      // This used to be an unscoped `SELECT` on the tenant pool: with no `app.org_id` set the policy
      // predicate is NULL and the read matched nothing, so every bearer token that will ever be presented
      // resolved to null and the whole FHIR-spec surface was unreachable (F-035, #95).
      if (!isUuid(token)) return null;
      const organizationId = await resolveSessionOrg(token);
      if (organizationId === null) return null;
      try {
        return await withOrgContext(db, ctx(organizationId), async (tx) => {
          const [row] = await tx
            .select({
              organizationId: SESSION.organizationId,
              clientId: SESSION.clientId,
              scopesGranted: SESSION.scopesGranted,
              expiresAt: SESSION.expiresAt,
              revokedAt: SESSION.revokedAt,
            })
            .from(SESSION)
            .where(eq(SESSION.jti, token))
            .limit(1);
          if (!row || row.revokedAt !== null || row.expiresAt <= new Date()) return null;
          const [client] = await tx
            .select({
              status: CLIENT.status,
              ipAllowlist: CLIENT.ipAllowlist,
              baaContractReference: CLIENT.baaContractReference,
              rateLimitRps: CLIENT.rateLimitRps,
            })
            .from(CLIENT)
            .where(eq(CLIENT.id, row.clientId))
            .limit(1);
          if (!client) return null;
          // `last_used_at` is what makes an idle-session sweep and a "which of my tokens is live"
          // console answer anything but null. Best-effort and inside the same org context; a failure to
          // stamp it must never refuse a read the credential is entitled to.
          await tx
            .update(SESSION)
            .set({ lastUsedAt: new Date() })
            .where(and(eq(SESSION.jti, token), eq(SESSION.organizationId, organizationId)));
          return {
            organizationId: row.organizationId,
            clientId: row.clientId,
            scopesGranted: asStringArray(row.scopesGranted),
            clientStatus: client.status,
            ipAllowlist: asStringArray(client.ipAllowlist),
            baaContractReference: client.baaContractReference,
            rateLimitRps: client.rateLimitRps,
          };
        });
      } catch {
        return null;
      }
    },

    async resolveClientForToken(clientId) {
      // Same tenant-resolution shape as `resolveBearer`, one credential earlier: a SMART Backend Services
      // token request presents a `client_id` and nothing else, so the org is read through
      // `fhir_resolve_client_org` (0233) and every subsequent statement is org-scoped.
      if (!isUuid(clientId)) return null;
      const organizationId = await resolveClientOrg(clientId);
      if (organizationId === null) return null;
      return withOrgContext(db, ctx(organizationId), async (tx) => {
        const [row] = await tx
          .select()
          .from(CLIENT)
          .where(and(eq(CLIENT.id, clientId), eq(CLIENT.organizationId, organizationId)))
          .limit(1);
        if (!row) return null;
        // Every credential that can currently authenticate this client: the `active` row plus any
        // `retired` row still inside its §2.2 30-day rotation overlap. `retired_at` is what bounds the
        // window — a row retired longer ago than that is excluded here rather than at compare time, so
        // an expired secret is not merely rejected but never loaded.
        const overlapFloor = new Date(Date.now() - FHIR_CREDENTIAL_ROTATION_OVERLAP_MS);
        const creds = await tx
          .select({
            digest: CRED.secretDigestSha256,
            status: CRED.status,
            retiredAt: CRED.retiredAt,
          })
          .from(CRED)
          .where(and(eq(CRED.clientId, clientId), eq(CRED.organizationId, organizationId)));
        const apiKeyDigests = creds
          .filter(
            (c) =>
              c.digest !== null &&
              (c.status === "active" ||
                (c.status === "retired" && c.retiredAt !== null && c.retiredAt > overlapFloor)),
          )
          .map((c) => c.digest as string);
        return {
          id: row.id,
          organizationId: row.organizationId,
          type: row.type,
          status: row.status,
          jwksUri: row.jwksUri,
          allowedScopes: asStringArray(row.allowedScopes),
          apiKeyDigests,
          ipAllowlist: asStringArray(row.ipAllowlist),
          baaContractReference: row.baaContractReference,
          rateLimitRps: row.rateLimitRps,
        };
      });
    },

    async mintSession(args) {
      await withOrgContext(db, ctx(args.organizationId), async (tx) => {
        await tx.insert(SESSION).values({
          jti: args.jti,
          organizationId: args.organizationId,
          clientId: args.clientId,
          scopesGranted: [...args.scopesGranted],
          issuedAt: new Date(args.issuedAt),
          expiresAt: new Date(args.expiresAt),
          tokenKeyFingerprint: args.tokenKeyFingerprint,
          ipAtIssue: args.ipAtIssue ?? null,
        });
      });
    },

    async recordDisclosure(envelope) {
      // §164.528 (F-035). Org-scoped like every other write here; the ledger grants `wardenx_app`
      // SELECT + INSERT only (0233), so this is the sole statement the application role can run against
      // it and an accounting row cannot later be edited away by the code that wrote it.
      await withOrgContext(db, ctx(envelope.organizationId), async (tx) => {
        await tx.insert(DISCLOSURE).values({
          organizationId: envelope.organizationId,
          fhirClientId: envelope.fhirClientId,
          resourceType: envelope.resourceType,
          patientId: envelope.patientId ?? null,
          queryParameters: envelope.queryParameters,
          resultCount: envelope.resultCount,
          servedAt: new Date(envelope.servedAt),
          initiatedByMembershipId: envelope.initiatedByMembershipId ?? null,
        });
      });
    },
  };
}

// A UUID helper the FHIR-spec bearer path uses when minting a Phase-1 jti (kept here to co-locate the
// token vocabulary with the store that persists it).
export const mintFhirJti = (): string => randomUUID();
