// apps/backend/src/modules/28-fhir/routes/store.ts — M28-T08 route-facing repo PORT + in-memory impl.
//
// The data surface the §4.1 routes compose over. Drizzle in prod (./store-drizzle.ts, org-scoped through
// `withOrgContext`); this in-memory implementation serves the §7 tests (W-FHIR-01/02/12) and any db-less
// boot. Both share the §2.2 FSM cores from `@wardenx/fhir` (`fhirClientTransition`,
// `fhirDualApprovalSatisfied`, `FHIR_CLIENT_CASCADE_ON_ENTRY`) so the in-memory path and the real path
// enforce the SAME dual-approval and cascade rules — a test that passes here is testing the rule, not a
// second spelling of it.
import { createHash, randomUUID } from "node:crypto";

import {
  FHIR_CLIENT_CASCADE_ON_ENTRY,
  fhirClientTransition,
  fhirDualApprovalSatisfied,
  fhirInboundOwnerModuleFor,
  inboundPayloadSha256,
} from "@wardenx/fhir";
import {
  FHIR_INBOUND_REJECT_RATIONALE_MIN_CHARS,
  FHIR_SESSION_TTL_MINUTES,
  type FhirBulkExportRequestKind,
  type FhirClientDetail,
  type FhirClientStatus,
  type FhirClientSummary,
  type FhirClientType,
  type FhirInboundOwnerModule,
  type FhirInboundStatus,
  type FhirReadDisclosureEnvelope,
  WardenXError,
} from "@wardenx/types";

import {
  type FhirRevocationCascadePort,
  type FhirRevocationCascadeResult,
  cascadeClientRevocation,
} from "./revocation-cascade";

/** The transactional-outbox port the composition root binds (the catalog-validating `m28` publisher;
 *  the M37 `WriteOutboxPort` shape). */
export interface FhirWriteOutboxPort {
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

export const NOOP_FHIR_OUTBOX: FhirWriteOutboxPort = { async publish() {} };

/** sha256 hex — what `fhir_client_credential.secret_digest_sha256` holds (never the plaintext). */
const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

// ── DTOs ──────────────────────────────────────────────────────────────────────────────────────────────

export interface FhirSessionSummary {
  readonly jti: string;
  readonly clientId: string;
  readonly scopesGranted: readonly string[];
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

export interface FhirBulkExportJobView {
  readonly id: string;
  readonly clientId: string;
  readonly requestKind: FhirBulkExportRequestKind;
  readonly resourceTypes: readonly string[];
  readonly status: string;
  readonly initiatedByMembershipId: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly expiresAt: string | null;
}

/** One NDJSON output of a completed export job (a `fhir_bulk_export_artifact` row). A blank `objectKey` means
 *  the object was purged (the sweeper blanks it once the bytes are gone). */
export interface FhirBulkExportArtifactView {
  readonly resourceType: string;
  readonly objectKey: string;
  readonly byteSize: number;
  readonly rowCount: number;
  readonly checksumSha256: string;
}

export interface FhirInboundProposalView {
  readonly id: string;
  readonly resourceType: string;
  readonly sourceClientId: string;
  readonly sourceFhirId: string | null;
  readonly ownerModule: FhirInboundOwnerModule;
  readonly proposalStatus: FhirInboundStatus;
  readonly payloadSha256: string;
  readonly proposedAt: string;
  readonly decidedByMembershipId: string | null;
  readonly decidedAt: string | null;
  readonly decisionRationale: string | null;
  readonly acceptedAggregateId: string | null;
}

export interface FhirTenantConfigView {
  readonly organizationId: string;
  readonly tenantFhirHost: string;
  readonly identifierUriBase: string;
  readonly inboundReviewSlaHours: number;
  readonly exportDedupWindowMinutes: number;
  readonly cursorKeyFingerprint: string;
}

export interface FhirClientCreateResult {
  readonly client: FhirClientDetail;
  /** Present for `api_key` clients — the plaintext secret, returned ONCE at creation. */
  readonly plaintextSecret: string | null;
}

export interface FhirCredentialRotationResult {
  readonly fingerprint: string;
  readonly plaintextSecret: string;
}

/** The FHIR-spec bearer actor a `resolveBearer` lookup returns. */
export interface FhirBearerContext {
  readonly organizationId: string;
  readonly clientId: string;
  readonly scopesGranted: readonly string[];
  readonly clientStatus: FhirClientStatus;
  /** GAP-083 — the client's request-time gates (D12/D16), read with the session so no second lookup. */
  readonly ipAllowlist: readonly string[];
  readonly baaContractReference: string;
  readonly rateLimitRps: number;
}

/**
 * What `/fhir/oauth2/token` needs to know about the presenting client BEFORE it can trust anything the
 * request said (F-035). Resolved from the `client_id` alone, because a SMART Backend Services token
 * request carries no tenant — the org on this view is what the mint then enters `withOrgContext` on.
 *
 * `apiKeyDigests` holds the sha256 digests of every credential currently able to authenticate this
 * client: the `active` one, plus any `retired` row still inside its §2.2 30-day rotation overlap. A list,
 * not a value, because rotation's whole purpose is a window where BOTH verify — collapsing it to one
 * would make every rotation an outage for whichever half the partner had not deployed yet. Empty for a
 * `smart_backend_services` client, which authenticates by signature and holds no shared secret at all.
 */
export interface FhirTokenClientView {
  readonly id: string;
  readonly organizationId: string;
  readonly type: FhirClientType;
  readonly status: FhirClientStatus;
  readonly jwksUri: string | null;
  readonly allowedScopes: readonly string[];
  readonly apiKeyDigests: readonly string[];
  /** GAP-083 — enforced on every mint and every read; empty = no IP restriction. */
  readonly ipAllowlist: readonly string[];
  readonly baaContractReference: string;
  /** D16 — the per-client steady rate; the token mint draws from the same bucket family as reads. */
  readonly rateLimitRps: number;
}

/** The `fhir_client_session` row the token route writes once an auth path has succeeded (§2.2). */
export interface FhirSessionMintArgs {
  readonly organizationId: string;
  readonly clientId: string;
  readonly jti: string;
  readonly scopesGranted: readonly string[];
  readonly issuedAt: string;
  readonly expiresAt: string;
  /** sha256 of the credential that minted this token — the assertion's `kid`, or the api-key digest. */
  readonly tokenKeyFingerprint: string;
  readonly ipAtIssue?: string | null;
}

export interface CreateClientArgs {
  readonly name: string;
  readonly type: FhirClientType;
  readonly jwksUri?: string;
  readonly allowedScopes: readonly string[];
  readonly tier: FhirClientSummary["tier"];
  readonly rateLimitRps: number;
  readonly ipAllowlist: readonly string[];
  readonly baaContractReference: string;
  /** The proposing Org Admin — stamped as the FIRST of the two D12 approvers. */
  readonly proposedByMembershipId: string;
}

export interface StageInboundArgs {
  readonly sourceClientId: string;
  readonly resourceType: string;
  readonly sourceFhirId: string | null;
  readonly payload: Record<string, unknown>;
}

/** The single data surface the §4.1 routes compose over. */
export interface FhirGatewayStore {
  // clients (R23-R28)
  listClients(
    orgId: string,
    filters: { status?: FhirClientStatus },
  ): Promise<readonly FhirClientSummary[]>;
  createClient(orgId: string, args: CreateClientArgs): Promise<FhirClientCreateResult>;
  getClient(orgId: string, clientId: string): Promise<FhirClientDetail | null>;
  approveClient(
    orgId: string,
    clientId: string,
    complianceMembershipId: string,
    rationale: string,
  ): Promise<FhirClientDetail>;
  revokeClient(
    orgId: string,
    clientId: string,
    membershipId: string,
    rationale: string,
  ): Promise<{ client: FhirClientDetail; cascade: FhirRevocationCascadeResult }>;
  suspendClient(
    orgId: string,
    clientId: string,
    membershipId: string,
    reason: string,
  ): Promise<{ client: FhirClientDetail; cascade: FhirRevocationCascadeResult }>;
  rotateCredential(
    orgId: string,
    clientId: string,
    membershipId: string,
  ): Promise<FhirCredentialRotationResult>;
  // sessions (R29-R30)
  listSessions(orgId: string, clientId: string): Promise<readonly FhirSessionSummary[]>;
  revokeSession(orgId: string, clientId: string, jti: string): Promise<void>;
  // bulk export (R31-R33)
  listJobs(
    orgId: string,
    filters: { status?: string; clientId?: string },
  ): Promise<readonly FhirBulkExportJobView[]>;
  createJob(
    orgId: string,
    args: {
      clientId: string;
      requestKind: FhirBulkExportRequestKind;
      groupId?: string;
      patientIds?: readonly string[];
      resourceTypes: readonly string[];
      since?: string;
      initiatedByMembershipId: string | null;
    },
  ): Promise<FhirBulkExportJobView>;
  getJob(orgId: string, jobId: string): Promise<FhirBulkExportJobView | null>;
  /** The output files of a `completed` job, ordered by resource type. */
  listJobArtifacts(orgId: string, jobId: string): Promise<readonly FhirBulkExportArtifactView[]>;
  cancelJob(
    orgId: string,
    jobId: string,
    membershipId: string | null,
  ): Promise<FhirBulkExportJobView>;
  // inbound (R34-R36 + R16)
  listProposals(
    orgId: string,
    filters: { ownerModule?: FhirInboundOwnerModule; status?: FhirInboundStatus },
  ): Promise<readonly FhirInboundProposalView[]>;
  getProposal(orgId: string, proposalId: string): Promise<FhirInboundProposalView | null>;
  acceptProposal(
    orgId: string,
    proposalId: string,
    membershipId: string,
    acceptedAggregateId: string,
    rationale: string | null,
  ): Promise<FhirInboundProposalView>;
  rejectProposal(
    orgId: string,
    proposalId: string,
    membershipId: string,
    rationale: string,
  ): Promise<FhirInboundProposalView>;
  stageInbound(orgId: string, args: StageInboundArgs): Promise<FhirInboundProposalView>;
  // config (R37-R39)
  getConfig(orgId: string): Promise<FhirTenantConfigView | null>;
  putConfig(
    orgId: string,
    args: {
      tenantFhirHost: string;
      identifierUriBase: string;
      inboundReviewSlaHours?: number;
      exportDedupWindowMinutes?: number;
    },
  ): Promise<FhirTenantConfigView>;
  rotateCursorKey(orgId: string): Promise<{ fingerprint: string }>;
  // FHIR bearer path
  resolveBearer(token: string): Promise<FhirBearerContext | null>;
  // token mint (R3) — both halves are TENANT-UNKNOWN at call time; see `fhir_resolve_client_org` (0233)
  resolveClientForToken(clientId: string): Promise<FhirTokenClientView | null>;
  mintSession(args: FhirSessionMintArgs): Promise<void>;
  /**
   * §164.528 — record one SERVED read in the disclosure ledger (F-035). Called after the response body is
   * assembled, so `resultCount` is the number of resources that actually crossed, and never before: a
   * read that 403s or 404s disclosed nothing and must not appear in an accounting.
   */
  recordDisclosure(envelope: FhirReadDisclosureEnvelope): Promise<void>;
}

/**
 * A store error carrying an HTTP status + a WardenX error code. Extends `WardenXError` so the composition
 * root's error handler renders it as the standard WardenX envelope with no per-route mapping (the admin
 * surface, §4.1 R23-R39, uses that envelope; the FHIR-spec surface catches it and renders OperationOutcome).
 */
export class FhirStoreError extends WardenXError {
  constructor(httpStatus: number, code: string, message: string) {
    super(code, message, httpStatus);
    this.name = "FhirStoreError";
  }

  get httpStatus(): number {
    return this.statusCode;
  }
}

// ── in-memory implementation ────────────────────────────────────────────────────────────────────────

interface MemClient {
  id: string;
  organizationId: string;
  name: string;
  type: FhirClientType;
  jwksUri: string | null;
  allowedScopes: string[];
  tier: FhirClientSummary["tier"];
  rateLimitRps: number;
  ipAllowlist: string[];
  baaContractReference: string;
  status: FhirClientStatus;
  approvedByAdminMembershipId: string | null;
  approvedByComplianceMembershipId: string | null;
  approvedAt: string | null;
  fingerprint: string | null;
  /** sha256 digests of the credentials that can authenticate this client (active + rotation overlap). */
  secretDigests: string[];
  createdAt: string;
}

interface MemSession {
  jti: string;
  organizationId: string;
  clientId: string;
  scopesGranted: string[];
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  token: string;
}

interface MemJob {
  id: string;
  organizationId: string;
  clientId: string;
  requestKind: FhirBulkExportRequestKind;
  resourceTypes: string[];
  status: string;
  initiatedByMembershipId: string | null;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string | null;
}

interface MemProposal {
  id: string;
  organizationId: string;
  resourceType: string;
  sourceClientId: string;
  sourceFhirId: string | null;
  ownerModule: FhirInboundOwnerModule;
  proposalStatus: FhirInboundStatus;
  payload: Record<string, unknown>;
  payloadSha256: string;
  proposedAt: string;
  decidedByMembershipId: string | null;
  decidedAt: string | null;
  decisionRationale: string | null;
  acceptedAggregateId: string | null;
}

interface MemConfig {
  organizationId: string;
  tenantFhirHost: string;
  identifierUriBase: string;
  inboundReviewSlaHours: number;
  exportDedupWindowMinutes: number;
  cursorKeyFingerprint: string;
}

export interface InMemoryFhirGatewaySeed {
  readonly clients?: readonly Partial<MemClient>[];
  readonly sessions?: readonly (Partial<MemSession> & {
    clientId: string;
    organizationId: string;
  })[];
  readonly jobs?: readonly (Partial<MemJob> & { clientId: string; organizationId: string })[];
  /** Artifact rows by job id (the in-memory store has no worker to produce them). */
  readonly artifacts?: Readonly<Record<string, readonly FhirBulkExportArtifactView[]>>;
  readonly now?: () => string;
  /**
   * Where `recordDisclosure` appends. Supplied by a test that needs to assert an accounting row was
   * written; omitted, the store keeps its own list. It is an OUT parameter rather than a getter on the
   * port because the port is the production contract and reading the ledger back is not part of it —
   * §164.528 accountings are served from the M30 scorecard seam, not from the route store.
   */
  readonly disclosureSink?: FhirReadDisclosureEnvelope[];
}

function toSummary(c: MemClient): FhirClientSummary {
  return {
    id: c.id,
    name: c.name,
    type: c.type,
    tier: c.tier,
    status: c.status,
    baaContractReference: c.baaContractReference,
    approvedAt: c.approvedAt,
    createdAt: c.createdAt,
  };
}

function toDetail(c: MemClient, activeSessionCount: number): FhirClientDetail {
  return {
    ...toSummary(c),
    allowedScopes: c.allowedScopes,
    rateLimitRps: c.rateLimitRps,
    ipAllowlist: c.ipAllowlist,
    jwksUri: c.jwksUri,
    fingerprint: c.fingerprint,
    lastSuccessfulRequestAt: null,
    activeSessionCount,
  };
}

/** §2.2 / §2.5 — one `accepted` / `in_progress` job per client; a second submission is a 429. */
export const activeJobError = (): FhirStoreError =>
  new FhirStoreError(
    429,
    "FHIR_EXPORT_ACTIVE_JOB",
    "this client already has a bulk export in progress; wait for it to finish or cancel it",
  );

function toJobView(j: MemJob): FhirBulkExportJobView {
  return {
    id: j.id,
    clientId: j.clientId,
    requestKind: j.requestKind,
    resourceTypes: j.resourceTypes,
    status: j.status,
    initiatedByMembershipId: j.initiatedByMembershipId,
    createdAt: j.createdAt,
    completedAt: j.completedAt,
    expiresAt: j.expiresAt,
  };
}

function toProposalView(p: MemProposal): FhirInboundProposalView {
  return {
    id: p.id,
    resourceType: p.resourceType,
    sourceClientId: p.sourceClientId,
    sourceFhirId: p.sourceFhirId,
    ownerModule: p.ownerModule,
    proposalStatus: p.proposalStatus,
    payloadSha256: p.payloadSha256,
    proposedAt: p.proposedAt,
    decidedByMembershipId: p.decidedByMembershipId,
    decidedAt: p.decidedAt,
    decisionRationale: p.decisionRationale,
    acceptedAggregateId: p.acceptedAggregateId,
  };
}

/** An in-memory `FhirGatewayStore` for the §7 tests + db-less boot. Not for production traffic. */
export function createInMemoryFhirGatewayStore(
  seed: InMemoryFhirGatewaySeed = {},
): FhirGatewayStore {
  const now = seed.now ?? (() => new Date().toISOString());
  const clients = new Map<string, MemClient>();
  const sessions = new Map<string, MemSession>();
  const jobs = new Map<string, MemJob>();
  const proposals = new Map<string, MemProposal>();
  const configs = new Map<string, MemConfig>();
  // The §164.528 accounting ledger. In Postgres this is `fhir_read_disclosure` (0233); here it is a list
  // the §7 suites read back through `readDisclosures`, so a test can assert that a served read WAS
  // accounted for — the assertion that matters, since a missing accounting looks exactly like a correct
  // one from the response side.
  const disclosures: FhirReadDisclosureEnvelope[] = seed.disclosureSink ?? [];

  for (const c of seed.clients ?? []) {
    const id = c.id ?? randomUUID();
    clients.set(id, {
      id,
      organizationId: c.organizationId ?? "",
      name: c.name ?? "seed",
      type: c.type ?? "api_key",
      jwksUri: c.jwksUri ?? null,
      allowedScopes: [...(c.allowedScopes ?? [])],
      tier: c.tier ?? "tier-2",
      rateLimitRps: c.rateLimitRps ?? 10,
      ipAllowlist: [...(c.ipAllowlist ?? [])],
      baaContractReference: c.baaContractReference ?? "baa-seed",
      status: c.status ?? "active",
      approvedByAdminMembershipId: c.approvedByAdminMembershipId ?? null,
      approvedByComplianceMembershipId: c.approvedByComplianceMembershipId ?? null,
      approvedAt: c.approvedAt ?? null,
      fingerprint: c.fingerprint ?? null,
      secretDigests: [...(c.secretDigests ?? [])],
      createdAt: c.createdAt ?? now(),
    });
  }

  for (const s of seed.sessions ?? []) {
    const jti = s.jti ?? randomUUID();
    sessions.set(jti, {
      jti,
      organizationId: s.organizationId,
      clientId: s.clientId,
      scopesGranted: [...(s.scopesGranted ?? [])],
      issuedAt: s.issuedAt ?? now(),
      expiresAt: s.expiresAt ?? new Date(Date.now() + 3600_000).toISOString(),
      revokedAt: s.revokedAt ?? null,
      token: s.token ?? jti,
    });
  }
  for (const j of seed.jobs ?? []) {
    const id = j.id ?? randomUUID();
    jobs.set(id, {
      id,
      organizationId: j.organizationId,
      clientId: j.clientId,
      requestKind: j.requestKind ?? "system",
      resourceTypes: [...(j.resourceTypes ?? [])],
      status: j.status ?? "accepted",
      initiatedByMembershipId: j.initiatedByMembershipId ?? null,
      createdAt: j.createdAt ?? now(),
      completedAt: j.completedAt ?? null,
      expiresAt: j.expiresAt ?? null,
    });
  }

  const clientInOrg = (orgId: string, clientId: string): MemClient => {
    const c = clients.get(clientId);
    if (!c || c.organizationId !== orgId) {
      throw new FhirStoreError(404, "FHIR_CLIENT_NOT_FOUND", "fhir_client not found");
    }
    return c;
  };

  const activeSessionCount = (clientId: string): number =>
    [...sessions.values()].filter(
      (s) => s.clientId === clientId && s.revokedAt === null && s.expiresAt > now(),
    ).length;

  const cascadePort: FhirRevocationCascadePort = {
    async activeSessionJtisForClient(_orgId, clientId) {
      return [...sessions.values()]
        .filter((s) => s.clientId === clientId && s.revokedAt === null && s.expiresAt > now())
        .map((s) => s.jti);
    },
    async revokeSession(_orgId, _clientId, jti) {
      const s = sessions.get(jti);
      if (s && s.revokedAt === null) s.revokedAt = now();
    },
    async inflightJobIdsForClient(_orgId, clientId) {
      return [...jobs.values()]
        .filter(
          (j) => j.clientId === clientId && (j.status === "accepted" || j.status === "in_progress"),
        )
        .map((j) => j.id);
    },
    async cancelJob(_orgId, jobId) {
      const j = jobs.get(jobId);
      if (j) j.status = "cancelled";
    },
  };

  const enterStatus = async (
    c: MemClient,
    to: FhirClientStatus,
  ): Promise<FhirRevocationCascadeResult> => {
    const transition = fhirClientTransition(c.status, to);
    if (transition === null) {
      throw new FhirStoreError(
        409,
        "FHIR_CLIENT_ILLEGAL_TRANSITION",
        `cannot transition fhir_client from ${c.status} to ${to}`,
      );
    }
    c.status = to;
    if (FHIR_CLIENT_CASCADE_ON_ENTRY.includes(to)) {
      return cascadeClientRevocation(c.organizationId, c.id, cascadePort);
    }
    return { sessionsRevoked: 0, jobsCancelled: 0 };
  };

  return {
    async listClients(orgId, filters) {
      return [...clients.values()]
        .filter(
          (c) => c.organizationId === orgId && (!filters.status || c.status === filters.status),
        )
        .map(toSummary);
    },

    async createClient(orgId, args) {
      const id = randomUUID();
      let plaintextSecret: string | null = null;
      let fingerprint: string | null = null;
      if (args.type === "api_key") {
        plaintextSecret = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
        fingerprint = plaintextSecret.slice(0, 8);
      }
      // The DIGEST, never the plaintext — this in-memory store mirrors what `fhir_client_credential`
      // persists (`secret_digest_sha256`), so an api-key token mint exercises the same compare here as
      // it does against Postgres.
      const secretDigests = plaintextSecret === null ? [] : [sha256Hex(plaintextSecret)];
      const c: MemClient = {
        id,
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
        approvedByComplianceMembershipId: null,
        approvedAt: null,
        fingerprint,
        secretDigests,
        createdAt: now(),
      };
      clients.set(id, c);
      return { client: toDetail(c, 0), plaintextSecret };
    },

    async getClient(orgId, clientId) {
      const c = clients.get(clientId);
      if (!c || c.organizationId !== orgId) return null;
      return toDetail(c, activeSessionCount(clientId));
    },

    async approveClient(orgId, clientId, complianceMembershipId, _rationale) {
      const c = clientInOrg(orgId, clientId);
      // D12 dual approval: the compliance approver must be DISTINCT from the proposing admin.
      if (!fhirDualApprovalSatisfied(c.approvedByAdminMembershipId, complianceMembershipId)) {
        throw new FhirStoreError(
          409,
          "FHIR_CLIENT_DUAL_APPROVAL_REQUIRED",
          "a fhir_client requires two DISTINCT approvers (Org Admin + Compliance Officer); self-approval is refused",
        );
      }
      c.approvedByComplianceMembershipId = complianceMembershipId;
      c.approvedAt = now();
      await enterStatus(c, "active");
      return toDetail(c, activeSessionCount(clientId));
    },

    async revokeClient(orgId, clientId, _membershipId, _rationale) {
      const c = clientInOrg(orgId, clientId);
      const cascade = await enterStatus(c, "revoked");
      return { client: toDetail(c, activeSessionCount(clientId)), cascade };
    },

    async suspendClient(orgId, clientId, _membershipId, _reason) {
      const c = clientInOrg(orgId, clientId);
      const cascade = await enterStatus(c, "suspended");
      return { client: toDetail(c, activeSessionCount(clientId)), cascade };
    },

    async rotateCredential(orgId, clientId, _membershipId) {
      const c = clientInOrg(orgId, clientId);
      const plaintextSecret = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
      c.fingerprint = plaintextSecret.slice(0, 8);
      // §2.2 rotation opens a 30-day overlap in which BOTH secrets authenticate; the prior digest stays
      // in the list rather than being replaced, or every rotation would be an outage for whichever half
      // the partner had not deployed yet.
      c.secretDigests = [sha256Hex(plaintextSecret), ...c.secretDigests];
      return { fingerprint: c.fingerprint, plaintextSecret };
    },

    async listSessions(orgId, clientId) {
      clientInOrg(orgId, clientId);
      return [...sessions.values()]
        .filter((s) => s.clientId === clientId && s.organizationId === orgId)
        .map((s) => ({
          jti: s.jti,
          clientId: s.clientId,
          scopesGranted: s.scopesGranted,
          issuedAt: s.issuedAt,
          expiresAt: s.expiresAt,
          revokedAt: s.revokedAt,
        }));
    },

    async revokeSession(orgId, clientId, jti) {
      clientInOrg(orgId, clientId);
      const s = sessions.get(jti);
      if (!s || s.clientId !== clientId || s.organizationId !== orgId) {
        throw new FhirStoreError(404, "FHIR_SESSION_NOT_FOUND", "fhir_client_session not found");
      }
      if (s.revokedAt === null) s.revokedAt = now();
    },

    async listJobs(orgId, filters) {
      return [...jobs.values()]
        .filter(
          (j) =>
            j.organizationId === orgId &&
            (!filters.status || j.status === filters.status) &&
            (!filters.clientId || j.clientId === filters.clientId),
        )
        .map(toJobView);
    },

    async createJob(orgId, args) {
      const active = [...jobs.values()].some(
        (x) =>
          x.organizationId === orgId &&
          x.clientId === args.clientId &&
          (x.status === "accepted" || x.status === "in_progress"),
      );
      if (active) throw activeJobError();
      const id = randomUUID();
      const j: MemJob = {
        id,
        organizationId: orgId,
        clientId: args.clientId,
        requestKind: args.requestKind,
        resourceTypes: [...args.resourceTypes],
        status: "accepted",
        initiatedByMembershipId: args.initiatedByMembershipId,
        createdAt: now(),
        completedAt: null,
        expiresAt: null,
      };
      jobs.set(id, j);
      return toJobView(j);
    },

    async getJob(orgId, jobId) {
      const j = jobs.get(jobId);
      if (!j || j.organizationId !== orgId) return null;
      return toJobView(j);
    },

    async listJobArtifacts(orgId, jobId) {
      const j = jobs.get(jobId);
      if (!j || j.organizationId !== orgId) return [];
      return seed.artifacts?.[jobId] ?? [];
    },

    async cancelJob(orgId, jobId, _membershipId) {
      const j = jobs.get(jobId);
      if (!j || j.organizationId !== orgId) {
        throw new FhirStoreError(
          404,
          "FHIR_EXPORT_JOB_NOT_FOUND",
          "fhir_bulk_export_job not found",
        );
      }
      if (j.status === "accepted" || j.status === "in_progress") j.status = "cancelled";
      return toJobView(j);
    },

    async listProposals(orgId, filters) {
      return [...proposals.values()]
        .filter(
          (p) =>
            p.organizationId === orgId &&
            (!filters.ownerModule || p.ownerModule === filters.ownerModule) &&
            (!filters.status || p.proposalStatus === filters.status),
        )
        .map(toProposalView);
    },

    async getProposal(orgId, proposalId) {
      const p = proposals.get(proposalId);
      if (!p || p.organizationId !== orgId) return null;
      return toProposalView(p);
    },

    async acceptProposal(orgId, proposalId, membershipId, acceptedAggregateId, rationale) {
      const p = proposals.get(proposalId);
      if (!p || p.organizationId !== orgId) {
        throw new FhirStoreError(404, "FHIR_PROPOSAL_NOT_FOUND", "fhir_inbound_resource not found");
      }
      if (p.proposalStatus !== "pending") {
        throw new FhirStoreError(409, "FHIR_PROPOSAL_DECIDED", "proposal already decided");
      }
      p.proposalStatus = "accepted";
      p.decidedByMembershipId = membershipId;
      p.decidedAt = now();
      p.decisionRationale = rationale;
      p.acceptedAggregateId = acceptedAggregateId;
      return toProposalView(p);
    },

    async rejectProposal(orgId, proposalId, membershipId, rationale) {
      const p = proposals.get(proposalId);
      if (!p || p.organizationId !== orgId) {
        throw new FhirStoreError(404, "FHIR_PROPOSAL_NOT_FOUND", "fhir_inbound_resource not found");
      }
      if (p.proposalStatus !== "pending") {
        throw new FhirStoreError(409, "FHIR_PROPOSAL_DECIDED", "proposal already decided");
      }
      if (rationale.trim().length < FHIR_INBOUND_REJECT_RATIONALE_MIN_CHARS) {
        throw new FhirStoreError(
          422,
          "FHIR_PROPOSAL_RATIONALE_TOO_SHORT",
          `a rejection rationale must be at least ${FHIR_INBOUND_REJECT_RATIONALE_MIN_CHARS} characters`,
        );
      }
      p.proposalStatus = "rejected";
      p.decidedByMembershipId = membershipId;
      p.decidedAt = now();
      p.decisionRationale = rationale;
      return toProposalView(p);
    },

    async stageInbound(orgId, args) {
      const ownerModule = fhirInboundOwnerModuleFor(args.resourceType);
      if (ownerModule === null) {
        throw new FhirStoreError(
          501,
          "FHIR_INBOUND_UNSUPPORTED",
          `no inbound owner module for resource type ${args.resourceType}`,
        );
      }
      const id = randomUUID();
      const p: MemProposal = {
        id,
        organizationId: orgId,
        resourceType: args.resourceType,
        sourceClientId: args.sourceClientId,
        sourceFhirId: args.sourceFhirId,
        ownerModule,
        proposalStatus: "pending",
        payload: args.payload,
        payloadSha256: inboundPayloadSha256(args.payload),
        proposedAt: now(),
        decidedByMembershipId: null,
        decidedAt: null,
        decisionRationale: null,
        acceptedAggregateId: null,
      };
      proposals.set(id, p);
      return toProposalView(p);
    },

    async getConfig(orgId) {
      return configs.get(orgId) ?? null;
    },

    async putConfig(orgId, args) {
      const cfg: MemConfig = {
        organizationId: orgId,
        tenantFhirHost: args.tenantFhirHost,
        identifierUriBase: args.identifierUriBase,
        inboundReviewSlaHours: args.inboundReviewSlaHours ?? 72,
        exportDedupWindowMinutes: args.exportDedupWindowMinutes ?? 10,
        cursorKeyFingerprint: configs.get(orgId)?.cursorKeyFingerprint ?? randomUUID().slice(0, 8),
      };
      configs.set(orgId, cfg);
      return cfg;
    },

    async rotateCursorKey(orgId) {
      const cfg = configs.get(orgId);
      if (!cfg) {
        throw new FhirStoreError(404, "FHIR_CONFIG_NOT_FOUND", "tenant_fhir_config not found");
      }
      cfg.cursorKeyFingerprint = randomUUID().slice(0, 8);
      return { fingerprint: cfg.cursorKeyFingerprint };
    },

    async resolveBearer(token) {
      const s = [...sessions.values()].find(
        (x) => x.token === token && x.revokedAt === null && x.expiresAt > now(),
      );
      if (!s) return null;
      const c = clients.get(s.clientId);
      if (!c) return null;
      return {
        organizationId: c.organizationId,
        clientId: c.id,
        scopesGranted: s.scopesGranted,
        clientStatus: c.status,
        ipAllowlist: c.ipAllowlist,
        baaContractReference: c.baaContractReference,
        rateLimitRps: c.rateLimitRps,
      };
    },

    async resolveClientForToken(clientId) {
      const c = clients.get(clientId);
      if (!c) return null;
      return {
        id: c.id,
        organizationId: c.organizationId,
        type: c.type,
        status: c.status,
        jwksUri: c.jwksUri,
        allowedScopes: c.allowedScopes,
        apiKeyDigests: c.secretDigests,
        ipAllowlist: c.ipAllowlist,
        baaContractReference: c.baaContractReference,
        rateLimitRps: c.rateLimitRps ?? 10,
      };
    },

    async mintSession(args) {
      sessions.set(args.jti, {
        jti: args.jti,
        organizationId: args.organizationId,
        clientId: args.clientId,
        scopesGranted: [...args.scopesGranted],
        issuedAt: args.issuedAt,
        expiresAt: args.expiresAt,
        revokedAt: null,
        // The in-memory store keeps token and jti as separate fields (a test may seed an opaque token);
        // the mint path sets them equal, which is what the Drizzle store does structurally — there, the
        // bearer IS the jti and there is no second column to disagree with it.
        token: args.jti,
      });
    },

    async recordDisclosure(envelope) {
      disclosures.push(envelope);
    },
  };
}

/** Test helper — seed an active session for the in-memory store so bearer/cascade tests have one. */
export interface FhirSessionSeed {
  readonly jti: string;
  readonly organizationId: string;
  readonly clientId: string;
  readonly scopesGranted: readonly string[];
  readonly token: string;
  readonly ttlMinutes?: number;
}

export { FHIR_SESSION_TTL_MINUTES };
