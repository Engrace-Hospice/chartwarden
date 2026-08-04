// apps/backend/src/modules/28-fhir/routes/store-drizzle.ts — M28-T08 the PRODUCTION FhirGatewayStore.
//
// The Drizzle-backed repo the §4.1 routes run against. Every org-scoped statement opens `withOrgContext`
// so RLS scopes it to the acting org and the M4 write-audit trigger stamps the acting membership as the
// actor (`userId` carries the membership id on the write path — the M18 idiom). The revocation cascade
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
import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm";

import { type FhirRevocationCascadePort, cascadeClientRevocation } from "./revocation-cascade";
import {
  type CreateClientArgs,
  type FhirBearerContext,
  type FhirBulkExportJobView,
  type FhirClientCreateResult,
  type FhirCredentialRotationResult,
  type FhirGatewayStore,
  type FhirInboundProposalView,
  type FhirSessionSummary,
  FhirStoreError,
  type FhirTenantConfigView,
  type StageInboundArgs,
} from "./store";

/** The Drizzle transaction handle `withOrgContext` hands its callback (full query-builder surface). */
type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export function createDrizzleFhirGatewayStore(db: DbClient): FhirGatewayStore {
  const CLIENT = schema.fhirClient;
  const CRED = schema.fhirClientCredential;
  const SESSION = schema.fhirClientSession;
  const JOB = schema.fhirBulkExportJob;
  const INBOUND = schema.fhirInboundResource;
  const CONFIG = schema.tenantFhirConfig;

  const ctx = (orgId: string, membershipId = "") => ({
    organizationId: orgId,
    userId: membershipId,
  });

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
      await tx
        .update(JOB)
        .set({ status: "cancelled" })
        .where(and(eq(JOB.id, jobId), eq(JOB.organizationId, orgId)));
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
      return withOrgContext(db, ctx(orgId, args.proposedByMembershipId), async (tx) => {
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
      return withOrgContext(db, ctx(orgId, complianceMembershipId), async (tx) => {
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
        const updated = await loadClientTx(tx, orgId, clientId);
        return clientDetailRow(updated, await activeSessionCount(tx, orgId, clientId));
      });
    },

    async revokeClient(orgId, clientId, membershipId, rationale) {
      return withOrgContext(db, ctx(orgId, membershipId), async (tx) => {
        const row = await loadClientTx(tx, orgId, clientId);
        const cascade = await enterStatus(tx, orgId, row, "revoked", {
          revokedAt: new Date(),
          revokedReason: rationale,
        });
        const updated = await loadClientTx(tx, orgId, clientId);
        return { client: clientDetailRow(updated, 0), cascade };
      });
    },

    async suspendClient(orgId, clientId, membershipId, _reason) {
      return withOrgContext(db, ctx(orgId, membershipId), async (tx) => {
        const row = await loadClientTx(tx, orgId, clientId);
        const cascade = await enterStatus(tx, orgId, row, "suspended", {});
        const updated = await loadClientTx(tx, orgId, clientId);
        return { client: clientDetailRow(updated, 0), cascade };
      });
    },

    async rotateCredential(orgId, clientId, membershipId): Promise<FhirCredentialRotationResult> {
      return withOrgContext(db, ctx(orgId, membershipId), async (tx) => {
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
      return withOrgContext(db, ctx(orgId, membershipId), async (tx) => {
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
        return jobView(row!);
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
      return withOrgContext(db, ctx(orgId, membershipId ?? ""), async (tx) => {
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
      return withOrgContext(db, ctx(orgId, membershipId), async (tx) => {
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
      return withOrgContext(db, ctx(orgId, membershipId), async (tx) => {
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
          })
          .where(and(eq(INBOUND.id, proposalId), eq(INBOUND.organizationId, orgId)));
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
        return proposalView(row!);
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
      // The Phase-1 bearer token IS the session `jti`. This lookup is cross-org (the caller carries no
      // WardenX session), so under `wardenx_app` RLS it returns nothing until a platform-bypass read path
      // is bound — fail-closed, which is the correct Phase-1 posture (no external client is live yet).
      try {
        const [row] = await db
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
        const [client] = await db
          .select({ status: CLIENT.status })
          .from(CLIENT)
          .where(eq(CLIENT.id, row.clientId))
          .limit(1);
        if (!client) return null;
        return {
          organizationId: row.organizationId,
          clientId: row.clientId,
          scopesGranted: asStringArray(row.scopesGranted),
          clientStatus: client.status,
        };
      } catch {
        return null;
      }
    },
  };
}

// A UUID helper the FHIR-spec bearer path uses when minting a Phase-1 jti (kept here to co-locate the
// token vocabulary with the store that persists it).
export const mintFhirJti = (): string => randomUUID();
