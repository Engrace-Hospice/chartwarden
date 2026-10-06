import {
  CASCADE_CONSUMERS,
  CONSENT_TYPE_STRUCTURE,
  type ConsentCaptureMethod,
  type ConsentCatalogView,
  type ConsentDpoaAgentView,
  type ConsentEvaluator,
  type ConsentGrantorKind,
  type ConsentRecipientView,
  type ConsentRecordView,
  type ConsentReminderKind,
  type ConsentRenewalCycleView,
  ConsentRouteError,
  type ConsentRouteService,
  type ConsentStore,
  type ConsentTypeKey,
  type ConsentTypeOverlayView,
  type ConsentVersionChainView,
  type CursorPage,
  type DelegatedAccessView,
  type EvalAuditRow,
  type ExpiringConsentView,
  type PostMortemEligibilityView,
  type RecipientResolvedKind,
  type StoredConsent,
  type StoredRecipient,
  consentTerminatesOnDeath,
  createConsentEvaluator,
  removeRecipient as decideRemoveRecipient,
  nextCascadeStatus,
  nextConsentStatus,
  recipientActive,
  validateCaptureEvidence,
  validateCaptureMethod,
  validateConsentOverlay,
  validateDpoaAgents,
  validateEffectiveWindow,
  validateGrantorChain,
  validateRecipientFk,
  validateRecipientRoster,
  validateRenewal,
  validateRevocation,
  validateSupersession,
  validateSurvivesDeath,
} from "@wardenx/consent";
// apps/backend/src/modules/39-consent — PRODUCTION consent data adapters over Drizzle (FB-T03).
//
// The `ConsentEvaluator` seam (packages/consent) is PURE ORCHESTRATION over a `ConsentStore` data
// port (post-death scope, per-recipient activeness, fail-closed redaction live in the evaluator, not
// the store); the §4.1 routes go through `ConsentRouteService`. The boot slice + unit tests inject
// the in-memory backends; production injects THESE, which read the real M39 tables. Mirrors the
// FB-T01 `TerminologyStore` + FB-T02 `MdmStore` live-store pattern: small factories closing over the
// DbClient.
//
// RLS shape (M39-T03, §3.5–3.7):
//   • `consent_type_catalog` is PLATFORM-SHARED reference (no organization_id; NON_ORG_SCOPED,
//     read-all via the dual-grant policy) — so the catalog read runs directly on the pooled
//     `wardenx_app` handle (no org context needed).
//   • `consent_record` / `consent_record_recipient` / `consent_eval_audit` are ORG-SCOPED PHI
//     (app.org_id RLS) — every read runs inside `withOrgContext` so RLS scopes to the actor's tenant.
//
// WX-PR-009: the legally operative lifecycle is live here too. Every command executes under tenant
// RLS in one transaction, validates the pure M39 state machine/evidence/authority rules, row-locks
// competing terminal transitions, encrypts optional notes before persistence, and writes its M1
// outbox event atomically. Signed rows are never edited; corrections mint supersession/renewal rows.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { WardenXError } from "@wardenx/types";
import { type SQL, and, desc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";

const CR = schema.consentRecord;
const CRR = schema.consentRecordRecipient;
const CAT = schema.consentTypeCatalog;
const CEA = schema.consentEvalAudit;
const CDA = schema.consentRecordDpoaAgent;
const CRC = schema.consentRenewalCycle;
const DA = schema.delegatedAccess;
const TCO = schema.tenantConsentTypeOverlay;
const REV = schema.consentRevocation;
const PATIENT = schema.patients;

/** The `consent_recipient_kind` values that are also a resolved disclosure-target class (§4.3). The
 *  evaluator matches by id, not kind, so the extra DB kinds (attorney/employer/free_text) carry no
 *  resolved kind — `undefined` is the same shape the in-memory slice gives an unkinded recipient.
 *
 *  `workforce_member` is load-bearing here, not decorative: it is the ONE kind the evaluator matches by
 *  KIND before matching by id (`evaluateForInternalAccess` asks "does this release name any workforce
 *  member at all?"), so dropping it to `undefined` would make every internal recipient invisible and
 *  silently restore the org-wide answer. */
const RESOLVED_KINDS = new Set<string>([
  "external_physician",
  "facility",
  "pharmacy",
  "irb",
  "family_member",
  "researcher",
  "workforce_member",
]);

function resolvedKindOf(kind: string): RecipientResolvedKind | undefined {
  return RESOLVED_KINDS.has(kind) ? (kind as RecipientResolvedKind) : undefined;
}

function ms(d: Date | null): number | null {
  return d === null ? null : d.getTime();
}

function iso(d: Date | null): string | null {
  return d === null ? null : d.toISOString();
}

/**
 * Build the production {@link ConsentStore} the {@link ConsentEvaluator} composes over. `consentsFor`
 * reads the patient's consent records (of the type) + their recipients under `withOrgContext`; the
 * evaluator applies status/expiry/post-death itself, so the store returns active-or-historical rows.
 */
export function createDbConsentStore(db: DbClient): ConsentStore {
  return {
    async consentsFor({ organizationId, patientId, typeKey, asOfMs: _asOfMs }) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const records = await tx
          .select()
          .from(CR)
          .where(
            and(
              eq(CR.organizationId, organizationId),
              eq(CR.patientId, patientId),
              eq(CR.typeKey, typeKey),
            ),
          );
        if (records.length === 0) return [];
        const ids = records.map((r) => r.id);
        const recips = await tx
          .select()
          .from(CRR)
          .where(and(eq(CRR.organizationId, organizationId), inArray(CRR.consentRecordId, ids)));
        const byConsent = new Map<string, StoredRecipient[]>();
        for (const r of recips) {
          const list =
            byConsent.get(r.consentRecordId) ??
            byConsent.set(r.consentRecordId, []).get(r.consentRecordId)!;
          list.push({
            recipientResolvedKind: resolvedKindOf(r.recipientKind),
            recipientResolvedId: r.recipientEntityId ?? undefined,
            recipientClientId: undefined, // no portal-client binding column in Phase 1
            removedAtMs: ms(r.removedAt),
            expiresAtMs: ms(r.expiresAt),
          });
        }
        return records.map(
          (r): StoredConsent => ({
            id: r.id,
            organizationId: r.organizationId,
            patientId: r.patientId,
            typeKey: r.typeKey as ConsentTypeKey,
            status: r.status,
            version: r.version,
            effectiveAtMs: r.effectiveAt.getTime(),
            expiresAtMs: ms(r.expiresAt),
            survivesDeath: r.survivesDeath,
            scopeDescriptor: r.scopeDescriptor,
            recipients: byConsent.get(r.id) ?? [],
          }),
        );
      });
    },

    async isPatientDeceased(_args) {
      // M5 owns the truth and M39 learns of a death by PUSH (spec §4.6 / §7.7): the bound
      // `m5.patient.deceased` consumer (`./m5-patient-deceased-consumer`, GAP-110) flips every active
      // non-survives-death consent to `expired` in the same delivery, and `pickGoverning` lets only an
      // `active` row govern — so the D13 termination is already the row's status. `PatientReader` exposes no
      // deceased signal (see consumed-seams.ts), hence no per-call pull. What this probe still answers
      // `false` for is the survives-death consents the cascade deliberately leaves active (D13).
      return false;
    },
  };
}

/** Compose the production {@link ConsentEvaluator} over the Drizzle store — what the composition root
 *  injects into the published seam (the disclosure/redaction gate every PHI-egress module consults). */
export function createDbConsentEvaluator(db: DbClient): ConsentEvaluator {
  return createConsentEvaluator(createDbConsentStore(db));
}

// ── consent_record row → ConsentRecordView (§4.1 read projection) ──────────────────────────────

function toRecordView(r: typeof CR.$inferSelect): ConsentRecordView {
  return {
    id: r.id,
    organizationId: r.organizationId,
    patientId: r.patientId,
    typeKey: r.typeKey as ConsentTypeKey,
    grantorKind: r.grantorKind as ConsentGrantorKind,
    captureMethod: r.captureMethod as ConsentCaptureMethod,
    scopeDescriptor: r.scopeDescriptor,
    status: r.status,
    version: r.version,
    effectiveAt: iso(r.effectiveAt),
    expiresAt: iso(r.expiresAt),
    signedAt: iso(r.signedAt),
    createdById: r.createdById,
    // The two ancestor edges route 5 walks, + the D13 survives-death flag route 28 verdicts on.
    supersedesConsentRecordId: r.supersedesConsentRecordId,
    renewedFromConsentRecordId: r.renewedFromConsentRecordId,
    survivesDeath: r.survivesDeath,
  };
}

export interface ConsentWriteOutboxPort {
  publish(
    tx: unknown,
    emission: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

export interface ConsentInternalNotesCipher {
  encrypt(organizationId: string, plaintext: string): Promise<string>;
}

export interface ConsentPatientReader {
  findById(input: { organizationId: string; id: string }): Promise<unknown | null>;
}

export interface DbConsentRouteServiceDeps {
  readonly outbox?: ConsentWriteOutboxPort;
  readonly cipher?: ConsentInternalNotesCipher;
  readonly patientReader?: ConsentPatientReader;
  readonly isPatientDeceased?: (organizationId: string, patientId: string) => Promise<boolean>;
}

function refuse(d: { ok: false; message: string }): never {
  throw new ConsentRouteError("validation", d.message);
}

function requireEvidence(
  method: ConsentCaptureMethod,
  evidence: Parameters<typeof validateCaptureEvidence>[0]["evidence"] | undefined,
): Record<string, unknown> {
  const supplied = evidence ?? {};
  const verdict = validateCaptureEvidence({ method, evidence: supplied });
  if (!verdict.ok) refuse(verdict);
  return { ...supplied };
}

function isDpoaAgentGrantor(kind: ConsentGrantorKind): boolean {
  return kind === "dpoa_healthcare_agent" || kind === "dpoa_financial_agent";
}

function tighterTermSeconds(
  platformSeconds: number | null,
  tenantSeconds: number | null | undefined,
): number | null {
  if (tenantSeconds === null || tenantSeconds === undefined) return platformSeconds;
  return platformSeconds === null ? tenantSeconds : Math.min(platformSeconds, tenantSeconds);
}

/** Chain-walk bound: a corrupt/cyclic supersedes edge must not spin a request (§4.1 route 5). */
const CHAIN_MAX = 200;

/** consent_record_recipient row → the §4.1 view (`active` from the pure recipient machine). */
function toRecipientView(r: typeof CRR.$inferSelect, nowMs: number): ConsentRecipientView {
  return {
    id: r.id,
    organizationId: r.organizationId,
    consentRecordId: r.consentRecordId,
    recipientKind: r.recipientKind,
    recipientEntityId: r.recipientEntityId,
    recipientDisplayName: r.recipientResolvedDisplayName,
    purposeCode: r.purposeCode,
    expiresAt: iso(r.expiresAt),
    addedAt: r.addedAt.toISOString(),
    addedById: r.addedById,
    removedAt: iso(r.removedAt),
    removedReasonText: r.removedReasonText,
    active: recipientActive({
      removedAtMs: ms(r.removedAt),
      expiresAtMs: ms(r.expiresAt),
      nowMs,
    }),
  };
}

/** consent_record_dpoa_agent row → the §4.1 view. An agent is active while un-removed and inside
 *  its term (`term_until` null = indefinite). */
function toDpoaView(
  a: typeof CDA.$inferSelect,
  patientId: string,
  nowMs: number,
): ConsentDpoaAgentView {
  return {
    id: a.id,
    organizationId: a.organizationId,
    consentRecordId: a.consentRecordId,
    patientId,
    agentKind: a.agentKind,
    agentName: a.agentName,
    agentRelationship: a.agentRelationship,
    scopeKind: a.scopeKind,
    activationCondition: a.activationCondition,
    termKind: a.termKind,
    termUntil: iso(a.termUntil),
    addedAt: a.addedAt.toISOString(),
    addedById: a.addedById,
    removedAt: iso(a.removedAt),
    active: a.removedAt === null && (a.termUntil === null || a.termUntil.getTime() > nowMs),
  };
}

/** Encode a generic keyset cursor (`sortKey|id`) — the expiring-consents page key (§4.12). */
function encodeKeysetCursor(sortKey: string, id: string): string {
  return Buffer.from(`${sortKey}|${id}`, "utf8").toString("base64url");
}

/** Encode/decode the opaque keyset cursor (`evaluatedAt|id`), mirroring the in-memory slice (§4.12 —
 *  never an offset). */
function encodeCursor(row: EvalAuditRow): string {
  return Buffer.from(`${row.evaluatedAt}|${row.id}`, "utf8").toString("base64url");
}
function decodeCursor(cursor: string): { sortKey: string; id: string } | null {
  try {
    const [sortKey, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    if (!sortKey || !id) return null;
    return { sortKey, id };
  } catch {
    return null;
  }
}

/**
 * Build the production {@link ConsentRouteService}: live RLS-scoped reads plus the transactional,
 * evidence-bearing lifecycle commands introduced by WX-PR-009.
 */
export function createDbConsentRouteService(
  db: DbClient,
  deps: DbConsentRouteServiceDeps = {},
): ConsentRouteService {
  const patientIsDeceased =
    deps.isPatientDeceased ??
    ((organizationId: string, patientId: string) =>
      withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const row = (
          await tx
            .select({ status: PATIENT.status })
            .from(PATIENT)
            .where(and(eq(PATIENT.organizationId, organizationId), eq(PATIENT.id, patientId)))
            .limit(1)
        )[0];
        return row?.status === "deceased";
      }));
  const publish = async (
    tx: unknown,
    eventName: string,
    organizationId: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ): Promise<void> => {
    if (!deps.outbox)
      throw new WardenXError(
        "SERVICE_UNAVAILABLE",
        "M39 transactional outbox is not bound; consent mutation refused",
        503,
      );
    await deps.outbox.publish(tx, {
      eventName,
      payload,
      organizationId,
      aggregateKind: "consent_record",
      aggregateId,
    });
  };

  const sealNotes = async (
    organizationId: string,
    plaintext: string | null | undefined,
  ): Promise<string | null | undefined> => {
    if (plaintext === undefined) return undefined;
    if (plaintext === null || plaintext === "") return null;
    if (!deps.cipher)
      throw new WardenXError(
        "SERVICE_UNAVAILABLE",
        "tenant DEK cipher is not bound; internal consent notes were not stored",
        503,
      );
    return deps.cipher.encrypt(organizationId, plaintext);
  };

  return {
    async readCatalog(_organizationId): Promise<ConsentCatalogView[]> {
      // Platform-shared reference (no org_id; read-all) — pooled handle, no org context.
      const rows = await db
        .select({
          typeKey: CAT.typeKey,
          displayNameEn: CAT.displayNameEn,
          scopeDiscriminator: CAT.scopeDiscriminator,
          isPerRecipient: CAT.isPerRecipient,
        })
        .from(CAT)
        .orderBy(CAT.typeKey);
      return rows.map((r) => ({
        typeKey: r.typeKey as ConsentTypeKey,
        displayNameEn: r.displayNameEn,
        scopeDiscriminator: r.scopeDiscriminator,
        isPerRecipient: r.isPerRecipient,
      }));
    },

    async listConsentsForPatient(organizationId, patientId): Promise<ConsentRecordView[]> {
      const rows = await withOrgContext(db, { organizationId, userId: "" }, (tx) =>
        tx
          .select()
          .from(CR)
          .where(
            and(
              eq(CR.organizationId, organizationId),
              eq(CR.patientId, patientId),
              eq(CR.status, "active"),
            ),
          )
          .orderBy(desc(CR.effectiveAt)),
      );
      return rows.map(toRecordView);
    },

    async getConsent(organizationId, consentId): Promise<ConsentRecordView | null> {
      const rows = await withOrgContext(db, { organizationId, userId: "" }, (tx) =>
        tx
          .select()
          .from(CR)
          .where(and(eq(CR.organizationId, organizationId), eq(CR.id, consentId)))
          .limit(1),
      );
      return rows[0] ? toRecordView(rows[0]) : null;
    },

    async createDraft(organizationId, input): Promise<ConsentRecordView> {
      const now = new Date();
      const effectiveAt = new Date(input.effectiveAt ?? now.toISOString());
      const notesCipher = await sealNotes(organizationId, input.internalNotesPlaintext);
      const sd = validateSurvivesDeath(input.typeKey, input.survivesDeath ?? false);
      if (!sd.ok) refuse(sd);
      if (deps.patientReader) {
        const patient = await deps.patientReader.findById({ organizationId, id: input.patientId });
        if (!patient) throw new ConsentRouteError("not_found", "patient not found");
      }
      return withOrgContext(db, { organizationId, userId: input.createdById }, async (tx) => {
        const catalog = (
          await tx.select().from(CAT).where(eq(CAT.typeKey, input.typeKey)).limit(1)
        )[0];
        if (!catalog) throw new ConsentRouteError("not_found", "consent type not found");
        const overlay = (
          await tx
            .select()
            .from(TCO)
            .where(and(eq(TCO.organizationId, organizationId), eq(TCO.typeKey, input.typeKey)))
            .limit(1)
        )[0];
        const capture = validateCaptureMethod({
          method: input.captureMethod,
          floor: catalog.captureMethodFloor as ConsentCaptureMethod[],
          tighter: (overlay?.tighterCaptureMethods ?? undefined) as
            | ConsentCaptureMethod[]
            | undefined,
        });
        if (!capture.ok) refuse(capture);
        if (overlay?.jurisdictionCodeRequired && !input.jurisdictionCode)
          throw new ConsentRouteError(
            "validation",
            "jurisdictionCode is required by the tenant consent policy",
          );
        const defaultTermSeconds = tighterTermSeconds(
          catalog.defaultExpirationSeconds,
          overlay?.tighterExpirationSeconds,
        );
        const expiresAt =
          input.expiresAt === null
            ? null
            : input.expiresAt
              ? new Date(input.expiresAt)
              : defaultTermSeconds === null
                ? null
                : new Date(effectiveAt.getTime() + defaultTermSeconds * 1000);
        const window = validateEffectiveWindow({
          effectiveAtMs: effectiveAt.getTime(),
          nowMs: now.getTime(),
          expiresAtMs: expiresAt?.getTime() ?? null,
          maxTermSeconds: tighterTermSeconds(
            catalog.maxTermSeconds,
            overlay?.tighterExpirationSeconds,
          ),
        });
        if (!window.ok) refuse(window);
        const acting = input.actingConsentId
          ? ((
              await tx
                .select({ status: CR.status, typeKey: CR.typeKey })
                .from(CR)
                .where(
                  and(
                    eq(CR.organizationId, organizationId),
                    eq(CR.id, input.actingConsentId),
                    eq(CR.patientId, input.patientId),
                  ),
                )
                .limit(1)
            )[0] ?? null)
          : null;
        const authority = validateGrantorChain({
          grantorKind: input.grantorKind,
          consentRecordId: null,
          actingConsentId: input.actingConsentId ?? null,
          actingConsent: acting
            ? { status: acting.status, typeKey: acting.typeKey as ConsentTypeKey }
            : null,
        });
        if (!authority.ok) refuse(authority);
        const [inserted] = await tx
          .insert(CR)
          .values({
            organizationId,
            patientId: input.patientId,
            typeKey: input.typeKey,
            scopeDescriptor: input.scopeDescriptor,
            grantorKind: input.grantorKind,
            grantorUserId: input.grantorUserId ?? null,
            grantorCaregiverId: input.grantorCaregiverId ?? null,
            grantorRelationshipText: input.grantorRelationshipText ?? null,
            actingConsentId: input.actingConsentId ?? null,
            effectiveAt,
            expiresAt,
            status: "draft",
            captureMethod: input.captureMethod,
            captureEvidenceJsonb: {},
            jurisdictionCode: input.jurisdictionCode ?? null,
            languageCode: input.languageCode ?? null,
            survivesDeath: input.survivesDeath ?? false,
            internalNotesCipher: notesCipher ?? null,
            createdById: input.createdById,
          })
          .returning();
        const row = inserted!;
        await publish(tx, "m39.consent.created", organizationId, row.id, {
          organizationId,
          patientId: row.patientId,
          consentRecordId: row.id,
          typeKey: row.typeKey,
        });
        return toRecordView(row);
      });
    },

    async signConsent(
      organizationId,
      consentId,
      signerId,
      nowIso,
      evidence,
      commandContext,
    ): Promise<ConsentRecordView> {
      const now = new Date(nowIso);
      return withOrgContext(db, { organizationId, userId: signerId }, async (tx) => {
        const row = (
          await tx
            .select()
            .from(CR)
            .where(and(eq(CR.organizationId, organizationId), eq(CR.id, consentId)))
            .limit(1)
            .for("update")
        )[0];
        if (!row) throw new ConsentRouteError("not_found", "consent not found");
        const transition = nextConsentStatus(row.status, "sign");
        if (!transition.ok) throw new ConsentRouteError("invalid_transition", transition.message);
        const catalog = (
          await tx.select().from(CAT).where(eq(CAT.typeKey, row.typeKey)).limit(1)
        )[0];
        if (!catalog) throw new ConsentRouteError("not_found", "consent type not found");
        const overlay = (
          await tx
            .select()
            .from(TCO)
            .where(and(eq(TCO.organizationId, organizationId), eq(TCO.typeKey, row.typeKey)))
            .limit(1)
        )[0];
        const capture = validateCaptureMethod({
          method: row.captureMethod as ConsentCaptureMethod,
          floor: catalog.captureMethodFloor as ConsentCaptureMethod[],
          tighter: (overlay?.tighterCaptureMethods ?? undefined) as
            | ConsentCaptureMethod[]
            | undefined,
        });
        if (!capture.ok) refuse(capture);
        const window = validateEffectiveWindow({
          effectiveAtMs: row.effectiveAt.getTime(),
          nowMs: now.getTime(),
          expiresAtMs: row.expiresAt?.getTime() ?? null,
          maxTermSeconds: tighterTermSeconds(
            catalog.maxTermSeconds,
            overlay?.tighterExpirationSeconds,
          ),
        });
        if (!window.ok) refuse(window);
        if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime())
          throw new ConsentRouteError("validation", "an expired draft cannot be signed");
        const immutableEvidence = requireEvidence(row.captureMethod, evidence);
        const acting = row.actingConsentId
          ? ((
              await tx
                .select({ status: CR.status, typeKey: CR.typeKey })
                .from(CR)
                .where(and(eq(CR.organizationId, organizationId), eq(CR.id, row.actingConsentId)))
                .limit(1)
            )[0] ?? null)
          : null;
        const authority = validateGrantorChain({
          grantorKind: row.grantorKind as ConsentGrantorKind,
          consentRecordId: row.id,
          actingConsentId: row.actingConsentId,
          actingConsent: acting
            ? { status: acting.status, typeKey: acting.typeKey as ConsentTypeKey }
            : null,
        });
        if (!authority.ok) refuse(authority);
        if (CONSENT_TYPE_STRUCTURE[row.typeKey as ConsentTypeKey].isPerNamedAgent) {
          const agents = await tx
            .select({ kind: CDA.agentKind })
            .from(CDA)
            .where(
              and(
                eq(CDA.organizationId, organizationId),
                eq(CDA.consentRecordId, row.id),
                isNull(CDA.removedAt),
              ),
            );
          const roster = validateDpoaAgents(agents.map((a) => a.kind));
          if (!roster.ok) refuse(roster);
        }
        if (row.typeKey === "42_cfr_part_2_release") {
          const activeRecipients = await tx
            .select({ id: CRR.id })
            .from(CRR)
            .where(
              and(
                eq(CRR.organizationId, organizationId),
                eq(CRR.consentRecordId, row.id),
                isNull(CRR.removedAt),
              ),
            );
          const roster = validateRecipientRoster(row.typeKey, activeRecipients.length);
          if (!roster.ok) refuse(roster);
        }
        const [updated] = await tx
          .update(CR)
          .set({
            status: "active",
            signedAt: now,
            signedById: signerId,
            captureEvidenceJsonb: {
              ...immutableEvidence,
              recordedAt: nowIso,
              stepUpSessionId: commandContext?.stepUpSessionId,
              membershipId: commandContext?.membershipId,
            },
            updatedAt: now,
          })
          .where(
            and(eq(CR.organizationId, organizationId), eq(CR.id, row.id), eq(CR.status, "draft")),
          )
          .returning();
        if (!updated)
          throw new ConsentRouteError("invalid_transition", "consent changed concurrently");
        await publish(tx, "m39.consent.signed", organizationId, row.id, {
          organizationId,
          patientId: row.patientId,
          consentRecordId: row.id,
          typeKey: row.typeKey,
          signedAt: nowIso,
          signedBy: signerId,
          captureMethod: row.captureMethod,
          ...(row.expiresAt ? { expiresAt: row.expiresAt.toISOString() } : {}),
        });
        return toRecordView(updated);
      });
    },

    async revokeConsent(
      organizationId,
      consentId,
      input,
      nowIso,
      _commandContext,
    ): Promise<ConsentRecordView> {
      const now = new Date(nowIso);
      return withOrgContext(db, { organizationId, userId: input.revokedById }, async (tx) => {
        const row = (
          await tx
            .select()
            .from(CR)
            .where(and(eq(CR.organizationId, organizationId), eq(CR.id, consentId)))
            .limit(1)
            .for("update")
        )[0];
        if (!row) throw new ConsentRouteError("not_found", "consent not found");
        const valid = validateRevocation(input);
        if (!valid.ok) refuse(valid);
        const transition = nextConsentStatus(row.status, "revoke");
        if (!transition.ok) throw new ConsentRouteError("invalid_transition", transition.message);
        const [revocation] = await tx
          .insert(REV)
          .values({
            organizationId,
            consentRecordId: row.id,
            revokedAt: now,
            revokedByKind: input.revokedByKind,
            revokedByUserId: input.revokedById,
            reasonText: input.reasonText,
            evidenceDocumentId: input.evidenceDocumentId,
            cascadeStatus: "pending",
            cascadeConsumerStatusJsonb: Object.fromEntries(
              CASCADE_CONSUMERS.map((c) => [c, false]),
            ),
          })
          .returning();
        const rev = revocation!;
        const [updated] = await tx
          .update(CR)
          .set({
            status: "revoked",
            revokedAt: now,
            revokedViaId: rev.id,
            updatedAt: now,
          })
          .where(
            and(eq(CR.organizationId, organizationId), eq(CR.id, row.id), eq(CR.status, "active")),
          )
          .returning();
        if (!updated)
          throw new ConsentRouteError("invalid_transition", "consent changed concurrently");
        await tx
          .update(CRC)
          .set({ status: "closed_revoked", closedAt: now, closedReason: "revoked" })
          .where(
            and(
              eq(CRC.organizationId, organizationId),
              eq(CRC.sourceConsentRecordId, row.id),
              eq(CRC.status, "open"),
            ),
          );
        await publish(tx, "m39.consent.revoked", organizationId, row.id, {
          organizationId,
          patientId: row.patientId,
          consentRecordId: row.id,
          revocationId: rev.id,
          typeKey: row.typeKey,
          revokedAt: nowIso,
          revokedByKind: input.revokedByKind,
          cascadeKind:
            (
              await tx
                .select({ kind: CAT.revocationCascadeKind })
                .from(CAT)
                .where(eq(CAT.typeKey, row.typeKey))
                .limit(1)
            )[0]?.kind ?? "consent_revocation",
        });
        return toRecordView(updated);
      });
    },

    // Every write below that MINTS OR MUTATES a `consent_record` row shares the createDraft
    // blocker — the §2.2.1 capture/step-up evidence + the per-tenant DEK for `internal_notes_cipher`
    // are unwired on the request handle. Writing them half-formed would corrupt an append-only,
    // legally-operative record, so they fail clear. The CHILD-row writes (recipients, DPOA agents,
    // the tenant overlay) carry neither the DEK nor the supersession chain and ARE live below.
    async updateDraft(organizationId, consentId, input): Promise<ConsentRecordView> {
      const notesCipher = await sealNotes(organizationId, input.internalNotesPlaintext);
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const current = (
          await tx
            .select()
            .from(CR)
            .where(and(eq(CR.organizationId, organizationId), eq(CR.id, consentId)))
            .limit(1)
            .for("update")
        )[0];
        if (!current) throw new ConsentRouteError("not_found", "consent not found");
        if (current.status !== "draft")
          throw new ConsentRouteError("invalid_transition", "only a draft consent is editable");
        if (input.survivesDeath !== undefined) {
          const sd = validateSurvivesDeath(current.typeKey as ConsentTypeKey, input.survivesDeath);
          if (!sd.ok) refuse(sd);
        }
        const patch: Record<string, unknown> = { updatedAt: new Date() };
        if (input.scopeDescriptor !== undefined) patch.scopeDescriptor = input.scopeDescriptor;
        if (input.captureMethod !== undefined) patch.captureMethod = input.captureMethod;
        if (input.grantorKind !== undefined) patch.grantorKind = input.grantorKind;
        if (input.survivesDeath !== undefined) patch.survivesDeath = input.survivesDeath;
        if (notesCipher !== undefined) patch.internalNotesCipher = notesCipher;
        const [updated] = await tx
          .update(CR)
          .set(patch)
          .where(
            and(
              eq(CR.organizationId, organizationId),
              eq(CR.id, consentId),
              eq(CR.status, "draft"),
            ),
          )
          .returning();
        if (!updated)
          throw new ConsentRouteError("invalid_transition", "consent changed concurrently");
        return toRecordView(updated);
      });
    },

    async supersedeConsent(
      organizationId,
      consentId,
      input,
      nowIso,
      commandContext,
    ): Promise<ConsentRecordView> {
      const now = new Date(nowIso);
      return withOrgContext(db, { organizationId, userId: input.createdById }, async (tx) => {
        const prior = (
          await tx
            .select()
            .from(CR)
            .where(and(eq(CR.organizationId, organizationId), eq(CR.id, consentId)))
            .limit(1)
            .for("update")
        )[0];
        if (!prior) throw new ConsentRouteError("not_found", "consent not found");
        const valid = validateSupersession({
          prior: { ...prior, typeKey: prior.typeKey as ConsentTypeKey },
          next: {
            typeKey: prior.typeKey as ConsentTypeKey,
            patientId: prior.patientId,
            organizationId,
          },
        });
        if (!valid.ok) refuse(valid);
        const sd = validateSurvivesDeath(
          prior.typeKey as ConsentTypeKey,
          input.survivesDeath ?? prior.survivesDeath,
        );
        if (!sd.ok) refuse(sd);
        const catalog = (
          await tx.select().from(CAT).where(eq(CAT.typeKey, prior.typeKey)).limit(1)
        )[0];
        if (!catalog) throw new ConsentRouteError("not_found", "consent type not found");
        const overlay = (
          await tx
            .select()
            .from(TCO)
            .where(and(eq(TCO.organizationId, organizationId), eq(TCO.typeKey, prior.typeKey)))
            .limit(1)
        )[0];
        const capture = validateCaptureMethod({
          method: input.captureMethod,
          floor: catalog.captureMethodFloor as ConsentCaptureMethod[],
          tighter: (overlay?.tighterCaptureMethods ?? undefined) as
            | ConsentCaptureMethod[]
            | undefined,
        });
        if (!capture.ok) refuse(capture);
        const window = validateEffectiveWindow({
          effectiveAtMs: now.getTime(),
          nowMs: now.getTime(),
          expiresAtMs: prior.expiresAt?.getTime() ?? null,
          maxTermSeconds: tighterTermSeconds(
            catalog.maxTermSeconds,
            overlay?.tighterExpirationSeconds,
          ),
        });
        if (!window.ok) refuse(window);
        const actingConsentId = isDpoaAgentGrantor(input.grantorKind)
          ? input.actingConsentId === undefined
            ? prior.actingConsentId
            : input.actingConsentId
          : null;
        const acting = actingConsentId
          ? ((
              await tx
                .select({ status: CR.status, typeKey: CR.typeKey })
                .from(CR)
                .where(
                  and(
                    eq(CR.organizationId, organizationId),
                    eq(CR.id, actingConsentId),
                    eq(CR.patientId, prior.patientId),
                  ),
                )
                .limit(1)
            )[0] ?? null)
          : null;
        const authority = validateGrantorChain({
          grantorKind: input.grantorKind,
          consentRecordId: null,
          actingConsentId,
          actingConsent: acting
            ? { status: acting.status, typeKey: acting.typeKey as ConsentTypeKey }
            : null,
        });
        if (!authority.ok) refuse(authority);
        const recipients = await tx
          .select()
          .from(CRR)
          .where(
            and(
              eq(CRR.organizationId, organizationId),
              eq(CRR.consentRecordId, prior.id),
              isNull(CRR.removedAt),
            ),
          );
        const activeRecipients = recipients.filter(
          (recipient) =>
            recipient.expiresAt === null || recipient.expiresAt.getTime() > now.getTime(),
        );
        const recipientRoster = validateRecipientRoster(
          prior.typeKey as ConsentTypeKey,
          activeRecipients.length,
        );
        if (!recipientRoster.ok) refuse(recipientRoster);
        const agents = CONSENT_TYPE_STRUCTURE[prior.typeKey as ConsentTypeKey].isPerNamedAgent
          ? await tx
              .select()
              .from(CDA)
              .where(
                and(
                  eq(CDA.organizationId, organizationId),
                  eq(CDA.consentRecordId, prior.id),
                  isNull(CDA.removedAt),
                ),
              )
          : [];
        const activeAgents = agents.filter(
          (agent) => agent.termUntil === null || agent.termUntil.getTime() > now.getTime(),
        );
        if (CONSENT_TYPE_STRUCTURE[prior.typeKey as ConsentTypeKey].isPerNamedAgent) {
          const agentRoster = validateDpoaAgents(activeAgents.map((agent) => agent.agentKind));
          if (!agentRoster.ok) refuse(agentRoster);
        }
        const evidence = requireEvidence(input.captureMethod, input.captureEvidence);
        const [next] = await tx
          .insert(CR)
          .values({
            organizationId,
            patientId: prior.patientId,
            typeKey: prior.typeKey,
            scopeDescriptor: input.scopeDescriptor,
            grantorKind: input.grantorKind,
            grantorUserId:
              input.grantorUserId === undefined ? prior.grantorUserId : input.grantorUserId,
            grantorCaregiverId:
              input.grantorCaregiverId === undefined
                ? prior.grantorCaregiverId
                : input.grantorCaregiverId,
            grantorRelationshipText:
              input.grantorRelationshipText === undefined
                ? prior.grantorRelationshipText
                : input.grantorRelationshipText,
            actingConsentId,
            effectiveAt: now,
            expiresAt: prior.expiresAt,
            status: "active",
            supersedesConsentRecordId: prior.id,
            captureMethod: input.captureMethod,
            captureEvidenceJsonb: { ...evidence, recordedAt: nowIso, ...commandContext },
            providerEntityId: prior.providerEntityId,
            locationId: prior.locationId,
            jurisdictionCode: prior.jurisdictionCode,
            languageCode: prior.languageCode,
            survivesDeath: input.survivesDeath ?? prior.survivesDeath,
            createdById: input.createdById,
            signedAt: now,
            signedById: input.createdById,
            version: prior.version + 1,
          })
          .returning();
        const created = next!;
        if (activeRecipients.length > 0)
          await tx.insert(CRR).values(
            activeRecipients.map((recipient) => ({
              organizationId,
              consentRecordId: created.id,
              recipientKind: recipient.recipientKind,
              recipientEntityId: recipient.recipientEntityId,
              recipientFreeText: recipient.recipientFreeText,
              recipientResolvedDisplayName: recipient.recipientResolvedDisplayName,
              purposeCode: recipient.purposeCode,
              purposeFreeText: recipient.purposeFreeText,
              expiresAt: recipient.expiresAt,
              addedAt: now,
              addedById: input.createdById,
            })),
          );
        if (activeAgents.length > 0)
          await tx.insert(CDA).values(
            activeAgents.map((agent) => ({
              organizationId,
              consentRecordId: created.id,
              agentKind: agent.agentKind,
              agentName: agent.agentName,
              agentRelationship: agent.agentRelationship,
              agentContactJsonb: agent.agentContactJsonb,
              agentExternalPhysicianId: agent.agentExternalPhysicianId,
              agentUserId: agent.agentUserId,
              agentCaregiverId: agent.agentCaregiverId,
              activationCondition: agent.activationCondition,
              activationEvidenceJsonb: agent.activationEvidenceJsonb,
              scopeKind: agent.scopeKind,
              termKind: agent.termKind,
              termUntil: agent.termUntil,
              stateSpecificJsonb: agent.stateSpecificJsonb,
              addedAt: now,
              addedById: input.createdById,
            })),
          );
        const [changed] = await tx
          .update(CR)
          .set({
            status: "superseded",
            supersededAt: now,
            supersededByConsentRecordId: created.id,
            updatedAt: now,
          })
          .where(
            and(
              eq(CR.organizationId, organizationId),
              eq(CR.id, prior.id),
              eq(CR.status, "active"),
            ),
          )
          .returning({ id: CR.id });
        if (!changed)
          throw new ConsentRouteError("invalid_transition", "consent changed concurrently");
        await publish(tx, "m39.consent.supersedes", organizationId, created.id, {
          organizationId,
          patientId: prior.patientId,
          newConsentRecordId: created.id,
          supersededConsentRecordId: prior.id,
          typeKey: prior.typeKey,
          supersededAt: nowIso,
        });
        return toRecordView(created);
      });
    },

    async renewConsent(
      organizationId,
      consentId,
      input,
      nowIso,
      commandContext,
    ): Promise<ConsentRecordView> {
      const now = new Date(nowIso);
      return withOrgContext(db, { organizationId, userId: input.createdById }, async (tx) => {
        const prior = (
          await tx
            .select()
            .from(CR)
            .where(and(eq(CR.organizationId, organizationId), eq(CR.id, consentId)))
            .limit(1)
            .for("update")
        )[0];
        if (!prior) throw new ConsentRouteError("not_found", "consent not found");
        const valid = validateRenewal({
          prior: {
            typeKey: prior.typeKey as ConsentTypeKey,
            patientId: prior.patientId,
            status: prior.status,
          },
          next: { typeKey: prior.typeKey as ConsentTypeKey, patientId: prior.patientId },
        });
        if (!valid.ok) refuse(valid);
        const existingRenewal = (
          await tx
            .select({ id: CR.id })
            .from(CR)
            .where(
              and(
                eq(CR.organizationId, organizationId),
                eq(CR.renewedFromConsentRecordId, prior.id),
              ),
            )
            .limit(1)
        )[0];
        if (existingRenewal)
          throw new ConsentRouteError("invalid_transition", "consent has already been renewed");
        const catalog = (
          await tx.select().from(CAT).where(eq(CAT.typeKey, prior.typeKey)).limit(1)
        )[0];
        if (!catalog) throw new ConsentRouteError("not_found", "consent type not found");
        const overlay = (
          await tx
            .select()
            .from(TCO)
            .where(and(eq(TCO.organizationId, organizationId), eq(TCO.typeKey, prior.typeKey)))
            .limit(1)
        )[0];
        const capture = validateCaptureMethod({
          method: input.captureMethod,
          floor: catalog.captureMethodFloor as ConsentCaptureMethod[],
          tighter: (overlay?.tighterCaptureMethods ?? undefined) as
            | ConsentCaptureMethod[]
            | undefined,
        });
        if (!capture.ok) refuse(capture);
        const defaultTermSeconds = tighterTermSeconds(
          catalog.defaultExpirationSeconds,
          overlay?.tighterExpirationSeconds,
        );
        const expiresAt =
          input.expiresAt === null
            ? null
            : input.expiresAt
              ? new Date(input.expiresAt)
              : defaultTermSeconds === null
                ? null
                : new Date(now.getTime() + defaultTermSeconds * 1000);
        const window = validateEffectiveWindow({
          effectiveAtMs: now.getTime(),
          nowMs: now.getTime(),
          expiresAtMs: expiresAt?.getTime() ?? null,
          maxTermSeconds: tighterTermSeconds(
            catalog.maxTermSeconds,
            overlay?.tighterExpirationSeconds,
          ),
        });
        if (!window.ok) refuse(window);
        const actingConsentId = isDpoaAgentGrantor(input.grantorKind)
          ? input.actingConsentId === undefined
            ? prior.actingConsentId
            : input.actingConsentId
          : null;
        const acting = actingConsentId
          ? ((
              await tx
                .select({ status: CR.status, typeKey: CR.typeKey })
                .from(CR)
                .where(
                  and(
                    eq(CR.organizationId, organizationId),
                    eq(CR.id, actingConsentId),
                    eq(CR.patientId, prior.patientId),
                  ),
                )
                .limit(1)
            )[0] ?? null)
          : null;
        const authority = validateGrantorChain({
          grantorKind: input.grantorKind,
          consentRecordId: null,
          actingConsentId,
          actingConsent: acting
            ? { status: acting.status, typeKey: acting.typeKey as ConsentTypeKey }
            : null,
        });
        if (!authority.ok) refuse(authority);
        const recipients = await tx
          .select()
          .from(CRR)
          .where(
            and(
              eq(CRR.organizationId, organizationId),
              eq(CRR.consentRecordId, prior.id),
              isNull(CRR.removedAt),
            ),
          );
        const activeRecipients = recipients.filter(
          (recipient) =>
            recipient.expiresAt === null || recipient.expiresAt.getTime() > now.getTime(),
        );
        const recipientRoster = validateRecipientRoster(
          prior.typeKey as ConsentTypeKey,
          activeRecipients.length,
        );
        if (!recipientRoster.ok) refuse(recipientRoster);
        const agents = CONSENT_TYPE_STRUCTURE[prior.typeKey as ConsentTypeKey].isPerNamedAgent
          ? await tx
              .select()
              .from(CDA)
              .where(
                and(
                  eq(CDA.organizationId, organizationId),
                  eq(CDA.consentRecordId, prior.id),
                  isNull(CDA.removedAt),
                ),
              )
          : [];
        const activeAgents = agents.filter(
          (agent) => agent.termUntil === null || agent.termUntil.getTime() > now.getTime(),
        );
        if (CONSENT_TYPE_STRUCTURE[prior.typeKey as ConsentTypeKey].isPerNamedAgent) {
          const agentRoster = validateDpoaAgents(activeAgents.map((agent) => agent.agentKind));
          if (!agentRoster.ok) refuse(agentRoster);
        }
        const evidence = requireEvidence(input.captureMethod, input.captureEvidence);
        const [next] = await tx
          .insert(CR)
          .values({
            organizationId,
            patientId: prior.patientId,
            typeKey: prior.typeKey,
            scopeDescriptor: input.scopeDescriptor,
            grantorKind: input.grantorKind,
            grantorUserId:
              input.grantorUserId === undefined ? prior.grantorUserId : input.grantorUserId,
            grantorCaregiverId:
              input.grantorCaregiverId === undefined
                ? prior.grantorCaregiverId
                : input.grantorCaregiverId,
            grantorRelationshipText:
              input.grantorRelationshipText === undefined
                ? prior.grantorRelationshipText
                : input.grantorRelationshipText,
            actingConsentId,
            effectiveAt: now,
            expiresAt,
            status: "active",
            renewedFromConsentRecordId: prior.id,
            captureMethod: input.captureMethod,
            captureEvidenceJsonb: { ...evidence, recordedAt: nowIso, ...commandContext },
            providerEntityId: prior.providerEntityId,
            locationId: prior.locationId,
            jurisdictionCode: prior.jurisdictionCode,
            languageCode: prior.languageCode,
            survivesDeath: prior.survivesDeath,
            createdById: input.createdById,
            signedAt: now,
            signedById: input.createdById,
            version: prior.version + 1,
          })
          .returning();
        const created = next!;
        if (activeRecipients.length > 0)
          await tx.insert(CRR).values(
            activeRecipients.map((recipient) => ({
              organizationId,
              consentRecordId: created.id,
              recipientKind: recipient.recipientKind,
              recipientEntityId: recipient.recipientEntityId,
              recipientFreeText: recipient.recipientFreeText,
              recipientResolvedDisplayName: recipient.recipientResolvedDisplayName,
              purposeCode: recipient.purposeCode,
              purposeFreeText: recipient.purposeFreeText,
              expiresAt: recipient.expiresAt,
              addedAt: now,
              addedById: input.createdById,
            })),
          );
        if (activeAgents.length > 0)
          await tx.insert(CDA).values(
            activeAgents.map((agent) => ({
              organizationId,
              consentRecordId: created.id,
              agentKind: agent.agentKind,
              agentName: agent.agentName,
              agentRelationship: agent.agentRelationship,
              agentContactJsonb: agent.agentContactJsonb,
              agentExternalPhysicianId: agent.agentExternalPhysicianId,
              agentUserId: agent.agentUserId,
              agentCaregiverId: agent.agentCaregiverId,
              activationCondition: agent.activationCondition,
              activationEvidenceJsonb: agent.activationEvidenceJsonb,
              scopeKind: agent.scopeKind,
              termKind: agent.termKind,
              termUntil: agent.termUntil,
              stateSpecificJsonb: agent.stateSpecificJsonb,
              addedAt: now,
              addedById: input.createdById,
            })),
          );
        await tx
          .update(CRC)
          .set({
            status: "renewed",
            closedAt: now,
            closedReason: "renewed",
            resolvedConsentRecordId: created.id,
          })
          .where(
            and(
              eq(CRC.organizationId, organizationId),
              eq(CRC.sourceConsentRecordId, prior.id),
              eq(CRC.status, "open"),
            ),
          );
        await publish(tx, "m39.consent.renewed", organizationId, created.id, {
          organizationId,
          patientId: prior.patientId,
          newConsentRecordId: created.id,
          renewedFromConsentRecordId: prior.id,
          typeKey: prior.typeKey,
          signedAt: nowIso,
        });
        return toRecordView(created);
      });
    },

    async createBereavementOutreachDraft(organizationId, input): Promise<ConsentRecordView> {
      if (input.grantorKind !== "bereaved_person_self")
        throw new ConsentRouteError(
          "validation",
          "bereavement outreach requires bereaved_person_self",
        );
      if (!(await patientIsDeceased(organizationId, input.patientId)))
        throw new ConsentRouteError(
          "validation",
          "bereavement outreach requires a deceased patient",
        );
      return this.createDraft(organizationId, {
        ...input,
        typeKey: "bereavement_outreach_consent",
        survivesDeath: false,
      });
    },

    // Both of these are transactional OUTBOX republish paths: re-render re-emits
    // `m39.consent.signed` for M22, and cascade retry records its attempt before re-dispatching the
    // §2.2.3 consumers. `publish` refuses when boot has not bound the outbox, so a 202 always means
    // durable work exists.
    async requestDocumentReRender(organizationId, consentId, requestedById, nowIso) {
      return withOrgContext(db, { organizationId, userId: requestedById }, async (tx) => {
        const row = (
          await tx
            .select()
            .from(CR)
            .where(and(eq(CR.organizationId, organizationId), eq(CR.id, consentId)))
            .limit(1)
        )[0];
        if (!row) throw new ConsentRouteError("not_found", "consent not found");
        if (row.status !== "active" && row.status !== "superseded")
          throw new ConsentRouteError(
            "invalid_transition",
            "only a signed consent can be rendered",
          );
        await publish(tx, "m39.consent.signed", organizationId, row.id, {
          organizationId,
          patientId: row.patientId,
          consentRecordId: row.id,
          typeKey: row.typeKey,
          signedAt: row.signedAt!.toISOString(),
          signedBy: row.signedById!,
          captureMethod: row.captureMethod,
          ...(row.expiresAt ? { expiresAt: row.expiresAt.toISOString() } : {}),
        });
        return {
          consentRecordId: row.id,
          requestedAt: nowIso,
          requestedById,
          eventType: "m39.consent.signed" as const,
        };
      });
    },

    async retryRevocationCascade(organizationId, consentId, nowIso) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const row = (
          await tx
            .select()
            .from(CR)
            .where(and(eq(CR.organizationId, organizationId), eq(CR.id, consentId)))
            .limit(1)
        )[0];
        if (!row) throw new ConsentRouteError("not_found", "consent not found");
        const rev = (
          await tx
            .select()
            .from(REV)
            .where(and(eq(REV.organizationId, organizationId), eq(REV.consentRecordId, consentId)))
            .limit(1)
            .for("update")
        )[0];
        if (!rev) throw new ConsentRouteError("not_found", "no revocation cascade on this consent");
        const consumers = rev.cascadeConsumerStatusJsonb as Record<string, boolean>;
        const meta = consumers as Record<string, boolean | number>;
        const attempts = (typeof meta.__attempts === "number" ? meta.__attempts : 0) + 1;
        const next = nextCascadeStatus({ status: rev.cascadeStatus, consumers, attempts });
        const status = next.ok ? next.value : "partial_failed";
        await tx
          .update(REV)
          .set({
            cascadeStatus: status,
            cascadeStartedAt: rev.cascadeStartedAt ?? new Date(nowIso),
            cascadeCompletedAt:
              status === "completed" || status === "partial_failed" ? new Date(nowIso) : null,
            cascadeConsumerStatusJsonb: { ...consumers, __attempts: attempts },
          })
          .where(eq(REV.id, rev.id));
        await publish(tx, "m39.consent.revoked", organizationId, row.id, {
          organizationId,
          patientId: row.patientId,
          consentRecordId: row.id,
          revocationId: rev.id,
          typeKey: row.typeKey,
          revokedAt: rev.revokedAt.toISOString(),
          revokedByKind: rev.revokedByKind,
          cascadeKind: "retry",
        });
        return {
          consentRecordId: row.id,
          revocationId: rev.id,
          status,
          attempts,
          pendingConsumers: Object.entries(consumers)
            .filter(([key, ack]) => key !== "__attempts" && !ack)
            .map(([key]) => key),
        };
      });
    },

    // ── 2. tenant overlay — TIGHTEN-ONLY (§7.6). Live: the platform floor comes from the
    // platform-shared catalog, the pure validator refuses a loosen, and the row upserts per
    // (organization_id, type_key).
    async upsertTenantOverlay(organizationId, input, nowIso): Promise<ConsentTypeOverlayView> {
      const floorRow = (
        await db
          .select({
            defaultExpirationSeconds: CAT.defaultExpirationSeconds,
            captureMethodFloor: CAT.captureMethodFloor,
            reminderCadenceFloor: CAT.reminderCadenceFloor,
            requiresJurisdictionCode: CAT.requiresJurisdictionCode,
          })
          .from(CAT)
          .where(eq(CAT.typeKey, input.typeKey))
          .limit(1)
      )[0];
      if (!floorRow)
        throw new WardenXError("NOT_FOUND", `consent type '${input.typeKey}' not found`, 404);

      const verdict = validateConsentOverlay(
        {
          defaultExpirationSeconds: floorRow.defaultExpirationSeconds,
          captureMethodFloor: floorRow.captureMethodFloor as ConsentCaptureMethod[],
          reminderCadenceFloor: floorRow.reminderCadenceFloor as ConsentReminderKind[],
          jurisdictionCodeRequired: floorRow.requiresJurisdictionCode,
        },
        {
          tighterExpirationSeconds: input.tighterExpirationSeconds,
          tighterCaptureMethods: input.tighterCaptureMethods,
          tighterReminderCadence: input.tighterReminderCadence as ConsentReminderKind[] | undefined,
          jurisdictionCodeRequired: input.jurisdictionCodeRequired,
        },
      );
      if (!verdict.ok) throw new ConsentRouteError("validation", verdict.message);

      const values = {
        organizationId,
        typeKey: input.typeKey,
        tighterExpirationSeconds: input.tighterExpirationSeconds ?? null,
        tighterCaptureMethods: input.tighterCaptureMethods ?? null,
        tighterReminderCadence: input.tighterReminderCadence ?? null,
        stateAddendumText: input.stateAddendumText ?? null,
        jurisdictionCodeRequired: input.jurisdictionCodeRequired ?? null,
        publishedAt: new Date(nowIso),
        publishedById: input.publishedById,
        updatedAt: new Date(nowIso),
      };
      const row = await withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [inserted] = await tx
          .insert(TCO)
          .values(values)
          .onConflictDoUpdate({
            target: [TCO.organizationId, TCO.typeKey],
            set: {
              tighterExpirationSeconds: values.tighterExpirationSeconds,
              tighterCaptureMethods: values.tighterCaptureMethods,
              tighterReminderCadence: values.tighterReminderCadence,
              stateAddendumText: values.stateAddendumText,
              jurisdictionCodeRequired: values.jurisdictionCodeRequired,
              publishedAt: values.publishedAt,
              publishedById: values.publishedById,
              updatedAt: values.updatedAt,
            },
          })
          .returning();
        return inserted!;
      });
      return {
        id: row.id,
        organizationId: row.organizationId,
        typeKey: row.typeKey as ConsentTypeKey,
        tighterExpirationSeconds: row.tighterExpirationSeconds,
        tighterCaptureMethods: row.tighterCaptureMethods,
        tighterReminderCadence: row.tighterReminderCadence,
        stateAddendumText: row.stateAddendumText,
        jurisdictionCodeRequired: row.jurisdictionCodeRequired,
        publishedAt: iso(row.publishedAt),
        publishedById: row.publishedById,
      };
    },

    // ── 5. version chain — walk both ancestor edges (D1 supersession, D13 renewal). Bounded by
    // CHAIN_MAX so a cyclic/corrupt edge cannot spin the request.
    async getVersionChain(organizationId, consentId): Promise<ConsentVersionChainView> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const head = (
          await tx
            .select()
            .from(CR)
            .where(and(eq(CR.organizationId, organizationId), eq(CR.id, consentId)))
            .limit(1)
        )[0];
        if (!head) throw new ConsentRouteError("not_found", "consent not found");

        const walk = async (startId: string | null): Promise<ConsentRecordView[]> => {
          const chain: ConsentRecordView[] = [];
          const seen = new Set<string>([head.id]);
          let cursor = startId;
          while (cursor && !seen.has(cursor) && chain.length < CHAIN_MAX) {
            seen.add(cursor);
            const prior = (
              await tx
                .select()
                .from(CR)
                .where(and(eq(CR.organizationId, organizationId), eq(CR.id, cursor)))
                .limit(1)
            )[0];
            if (!prior) break;
            chain.push(toRecordView(prior));
            cursor = prior.supersedesConsentRecordId ?? prior.renewedFromConsentRecordId ?? null;
          }
          return chain.reverse(); // oldest first
        };

        return {
          consentId: head.id,
          supersedes: await walk(head.supersedesConsentRecordId),
          renewedFrom: await walk(head.renewedFromConsentRecordId),
        };
      });
    },

    // ── 11. recipients on a consent (active + historical; `active` derives from the pure machine).
    async listRecipients(organizationId, consentId, nowIso): Promise<ConsentRecipientView[]> {
      const nowMs = Date.parse(nowIso);
      const rows = await withOrgContext(db, { organizationId, userId: "" }, (tx) =>
        tx
          .select()
          .from(CRR)
          .where(and(eq(CRR.organizationId, organizationId), eq(CRR.consentRecordId, consentId)))
          .orderBy(desc(CRR.addedAt)),
      );
      return rows.map((r) => toRecipientView(r, nowMs));
    },

    // ── 12. add a named recipient. Live: no DEK, no supersession chain — a child row on an
    // existing consent. The per-recipient legality + the FK/kind rule are checked first.
    async addRecipient(organizationId, consentId, input, nowIso): Promise<ConsentRecipientView> {
      const fk = validateRecipientFk({
        kind: input.recipientKind,
        entityId: input.recipientEntityId,
        freeText: input.recipientFreeText,
      });
      if (!fk.ok) throw new ConsentRouteError("validation", fk.message);

      const row = await withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const parent = (
          await tx
            .select({ typeKey: CR.typeKey, patientId: CR.patientId, status: CR.status })
            .from(CR)
            .where(and(eq(CR.organizationId, organizationId), eq(CR.id, consentId)))
            .limit(1)
        )[0];
        if (!parent) throw new ConsentRouteError("not_found", "consent not found");
        if (parent.status !== "draft" && parent.status !== "active")
          throw new ConsentRouteError(
            "invalid_transition",
            "recipients cannot be added to a terminal consent version",
          );
        if (!CONSENT_TYPE_STRUCTURE[parent.typeKey as ConsentTypeKey].isPerRecipient)
          throw new ConsentRouteError(
            "validation",
            `consent type '${parent.typeKey}' does not enumerate named recipients (D6)`,
          );
        const [inserted] = await tx
          .insert(CRR)
          .values({
            organizationId,
            consentRecordId: consentId,
            recipientKind: input.recipientKind,
            recipientEntityId: input.recipientEntityId,
            recipientFreeText: input.recipientFreeText,
            recipientResolvedDisplayName: input.recipientDisplayName,
            purposeCode: input.purposeCode ?? null,
            expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
            addedAt: new Date(nowIso),
            addedById: input.addedById,
          })
          .returning();
        await publish(tx, "m39.consent.recipient_added", organizationId, consentId, {
          organizationId,
          patientId: parent.patientId,
          consentRecordId: consentId,
          recipientId: inserted!.id,
          recipientKind: inserted!.recipientKind,
          ...(inserted!.recipientEntityId
            ? { recipientEntityId: inserted!.recipientEntityId }
            : {}),
        });
        return inserted!;
      });
      return toRecipientView(row, Date.parse(nowIso));
    },

    // ── 13. remove a recipient — flips `removed_at`; the row is NEVER deleted (a disclosure target
    // that was once authorized stays in the record).
    async removeRecipient(
      organizationId,
      consentId,
      recipientId,
      input,
      nowIso,
    ): Promise<ConsentRecipientView> {
      const row = await withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const parent = (
          await tx
            .select({ patientId: CR.patientId })
            .from(CR)
            .where(and(eq(CR.organizationId, organizationId), eq(CR.id, consentId)))
            .limit(1)
        )[0];
        if (!parent) throw new ConsentRouteError("not_found", "consent not found");
        const current = (
          await tx
            .select()
            .from(CRR)
            .where(
              and(
                eq(CRR.organizationId, organizationId),
                eq(CRR.consentRecordId, consentId),
                eq(CRR.id, recipientId),
              ),
            )
            .limit(1)
        )[0];
        if (!current) throw new ConsentRouteError("not_found", "recipient not found");
        const d = decideRemoveRecipient(
          current.removedAt === null ? null : current.removedAt.getTime(),
        );
        if (!d.ok) throw new ConsentRouteError("invalid_transition", d.message);

        const [updated] = await tx
          .update(CRR)
          .set({
            removedAt: new Date(nowIso),
            removedById: input.removedById,
            removedReasonText: input.removedReasonText,
          })
          .where(and(eq(CRR.organizationId, organizationId), eq(CRR.id, recipientId)))
          .returning();
        await publish(tx, "m39.consent.recipient_removed", organizationId, consentId, {
          organizationId,
          patientId: parent.patientId,
          consentRecordId: consentId,
          recipientId,
          removedAt: nowIso,
        });
        return updated!;
      });
      return toRecipientView(row, Date.parse(nowIso));
    },

    // ── 14. DPOA agents on a consent (active + historical).
    async listDpoaAgents(organizationId, consentId, nowIso): Promise<ConsentDpoaAgentView[]> {
      const nowMs = Date.parse(nowIso);
      const rows = await withOrgContext(db, { organizationId, userId: "" }, (tx) =>
        tx
          .select({ agent: CDA, patientId: CR.patientId })
          .from(CDA)
          .innerJoin(CR, eq(CDA.consentRecordId, CR.id))
          .where(and(eq(CDA.organizationId, organizationId), eq(CDA.consentRecordId, consentId)))
          .orderBy(CDA.agentKind),
      );
      return rows.map((r) => toDpoaView(r.agent, r.patientId, nowMs));
    },

    // ── 15. name a DPOA agent. The D5 ≤1-active-per-kind rule is enforced before the INSERT so a
    // duplicate is a 422, not a partial-unique-index 23505.
    async addDpoaAgent(organizationId, consentId, input, nowIso): Promise<ConsentDpoaAgentView> {
      const nowMs = Date.parse(nowIso);
      const { row, patientId } = await withOrgContext(
        db,
        { organizationId, userId: "" },
        async (tx) => {
          const parent = (
            await tx
              .select({ typeKey: CR.typeKey, patientId: CR.patientId })
              .from(CR)
              .where(and(eq(CR.organizationId, organizationId), eq(CR.id, consentId)))
              .limit(1)
          )[0];
          if (!parent) throw new ConsentRouteError("not_found", "consent not found");
          if (!CONSENT_TYPE_STRUCTURE[parent.typeKey as ConsentTypeKey].isPerNamedAgent)
            throw new ConsentRouteError(
              "validation",
              `consent type '${parent.typeKey}' does not enumerate named agents (D5)`,
            );

          const existing = await tx
            .select()
            .from(CDA)
            .where(and(eq(CDA.organizationId, organizationId), eq(CDA.consentRecordId, consentId)));
          const activeSameKind = existing
            .map((a) => toDpoaView(a, parent.patientId, nowMs))
            .some((a) => a.active && a.agentKind === input.agentKind);
          if (activeSameKind)
            throw new ConsentRouteError(
              "validation",
              `an active ${input.agentKind} agent already exists on this consent (D5)`,
            );

          const [inserted] = await tx
            .insert(CDA)
            .values({
              organizationId,
              consentRecordId: consentId,
              agentKind: input.agentKind,
              agentName: input.agentName,
              agentRelationship: input.agentRelationship,
              agentContactJsonb: input.agentContact,
              activationCondition: input.activationCondition,
              scopeKind: input.scopeKind,
              termKind: input.termKind,
              termUntil: input.termUntil ? new Date(input.termUntil) : null,
              addedAt: new Date(nowIso),
              addedById: input.addedById,
            })
            .returning();
          return { row: inserted!, patientId: parent.patientId };
        },
      );
      return toDpoaView(row, patientId, nowMs);
    },

    // ── 16. mutate a DPOA agent's scope / activation / term, or retire it.
    async updateDpoaAgent(
      organizationId,
      consentId,
      agentId,
      input,
      nowIso,
    ): Promise<ConsentDpoaAgentView> {
      const nowMs = Date.parse(nowIso);
      const { row, patientId } = await withOrgContext(
        db,
        { organizationId, userId: "" },
        async (tx) => {
          const parent = (
            await tx
              .select({ patientId: CR.patientId })
              .from(CR)
              .where(and(eq(CR.organizationId, organizationId), eq(CR.id, consentId)))
              .limit(1)
          )[0];
          if (!parent) throw new ConsentRouteError("not_found", "consent not found");
          const current = (
            await tx
              .select()
              .from(CDA)
              .where(
                and(
                  eq(CDA.organizationId, organizationId),
                  eq(CDA.consentRecordId, consentId),
                  eq(CDA.id, agentId),
                ),
              )
              .limit(1)
          )[0];
          if (!current) throw new ConsentRouteError("not_found", "DPOA agent not found");
          if (current.removedAt !== null)
            throw new ConsentRouteError("invalid_transition", "DPOA agent is already removed");

          const patch: Record<string, unknown> = {};
          if (input.scopeKind !== undefined) patch.scopeKind = input.scopeKind;
          if (input.activationCondition !== undefined)
            patch.activationCondition = input.activationCondition;
          if (input.termKind !== undefined) patch.termKind = input.termKind;
          if (input.termUntil !== undefined)
            patch.termUntil = input.termUntil ? new Date(input.termUntil) : null;
          if (input.remove === true) {
            patch.removedAt = new Date(nowIso);
            patch.removedById = input.removedById ?? null;
          }
          if (Object.keys(patch).length === 0) return { row: current, patientId: parent.patientId };

          const [updated] = await tx
            .update(CDA)
            .set(patch)
            .where(and(eq(CDA.organizationId, organizationId), eq(CDA.id, agentId)))
            .returning();
          return { row: updated!, patientId: parent.patientId };
        },
      );
      return toDpoaView(row, patientId, nowMs);
    },

    // ── 17. the patient's ACTIVE primary DPOA agent — joined through the patient's ACTIVE
    // per-named-agent consents (an agent on a revoked/superseded consent does not decide).
    async activePrimaryDpoa(
      organizationId,
      patientId,
      nowIso,
    ): Promise<ConsentDpoaAgentView | null> {
      const nowMs = Date.parse(nowIso);
      const rows = await withOrgContext(db, { organizationId, userId: "" }, (tx) =>
        tx
          .select({ agent: CDA })
          .from(CDA)
          .innerJoin(CR, eq(CDA.consentRecordId, CR.id))
          .where(
            and(
              eq(CDA.organizationId, organizationId),
              eq(CR.patientId, patientId),
              eq(CR.status, "active"),
              eq(CDA.agentKind, "primary"),
              isNull(CDA.removedAt),
            ),
          ),
      );
      const match = rows.map((r) => toDpoaView(r.agent, patientId, nowMs)).find((a) => a.active);
      return match ?? null;
    },

    // ── 18. consents inside the expiry window, keyset-paginated on (expires_at, id) ASC (§4.12).
    async listExpiringConsents(
      organizationId,
      patientId,
      windowDays,
      nowIso,
      page,
    ): Promise<CursorPage<ExpiringConsentView>> {
      const nowMs = Date.parse(nowIso);
      const horizon = new Date(nowMs + windowDays * 24 * 3600 * 1000);
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const where: (SQL | undefined)[] = [
          eq(CR.organizationId, organizationId),
          eq(CR.patientId, patientId),
          eq(CR.status, "active"),
          gt(CR.expiresAt, new Date(nowMs)),
          lte(CR.expiresAt, horizon),
        ];
        if (page.cursor) {
          const c = decodeCursor(page.cursor);
          // Keyset (expires_at, id) ASC — strictly after the cursor (§4.12, never an offset).
          if (c) where.push(sql`(${CR.expiresAt}, ${CR.id}) > (${c.sortKey}, ${c.id})`);
        }
        const rows = await tx
          .select()
          .from(CR)
          .where(and(...where))
          .orderBy(CR.expiresAt, CR.id)
          .limit(page.pageSize + 1);
        const hasMore = rows.length > page.pageSize;
        const pageRows: ExpiringConsentView[] = rows.slice(0, page.pageSize).map((r) => {
          const view = toRecordView(r);
          return {
            ...view,
            daysUntilExpiry: Math.max(
              0,
              Math.ceil(((r.expiresAt as Date).getTime() - nowMs) / (24 * 3600 * 1000)),
            ),
          };
        });
        const last = pageRows[pageRows.length - 1];
        const nextCursor =
          hasMore && last?.expiresAt ? encodeKeysetCursor(last.expiresAt, last.id) : null;
        return { rows: pageRows, nextCursor };
      });
    },

    // ── 19. renewal cycles on a record (open + closed).
    async listRenewalCycles(organizationId, consentId): Promise<ConsentRenewalCycleView[]> {
      const rows = await withOrgContext(db, { organizationId, userId: "" }, (tx) =>
        tx
          .select()
          .from(CRC)
          .where(
            and(eq(CRC.organizationId, organizationId), eq(CRC.sourceConsentRecordId, consentId)),
          )
          .orderBy(desc(CRC.cycleStartedAt)),
      );
      return rows.map((c) => ({
        id: c.id,
        organizationId: c.organizationId,
        sourceConsentRecordId: c.sourceConsentRecordId,
        patientId: c.patientId,
        status: c.status,
        cycleStartedAt: c.cycleStartedAt.toISOString(),
        nextActionDueAt: iso(c.nextActionDueAt),
        closedAt: iso(c.closedAt),
        closedReason: c.closedReason,
        resolvedConsentRecordId: c.resolvedConsentRecordId,
        assignedToMembershipId: c.assignedToMembershipId,
      }));
    },

    // ── 21. the D10 delegated-access projection rows for a patient.
    async listDelegatedAccess(organizationId, patientId, nowIso): Promise<DelegatedAccessView[]> {
      const nowMs = Date.parse(nowIso);
      const rows = await withOrgContext(db, { organizationId, userId: "" }, (tx) =>
        tx
          .select()
          .from(DA)
          .where(and(eq(DA.organizationId, organizationId), eq(DA.patientId, patientId)))
          .orderBy(desc(DA.effectiveFrom)),
      );
      return rows.map((d) => ({
        id: d.id,
        organizationId: d.organizationId,
        patientId: d.patientId,
        consentRecordId: d.consentRecordId,
        consentRecordRecipientId: d.consentRecordRecipientId,
        delegateUserId: d.delegateUserId,
        delegateCaregiverId: d.delegateCaregiverId,
        scope: d.scopeKind,
        effectiveFrom: d.effectiveFrom.toISOString(),
        effectiveUntil: iso(d.effectiveUntil),
        portalSessionClass: d.portalSessionClass,
        revokedAt: iso(d.revokedAt),
        active:
          d.revokedAt === null &&
          d.effectiveFrom.getTime() <= nowMs &&
          (d.effectiveUntil === null || d.effectiveUntil.getTime() > nowMs),
      }));
    },

    // ── 28. which of the patient's consents survive death (the M16 consumer view, D13). The
    // verdict itself is the pure `consentTerminatesOnDeath`; this only supplies the rows.
    async listPostMortemEligible(organizationId, patientId): Promise<PostMortemEligibilityView[]> {
      const rows = await withOrgContext(db, { organizationId, userId: "" }, (tx) =>
        tx
          .select({
            id: CR.id,
            typeKey: CR.typeKey,
            status: CR.status,
            survivesDeath: CR.survivesDeath,
          })
          .from(CR)
          .where(and(eq(CR.organizationId, organizationId), eq(CR.patientId, patientId))),
      );
      return rows.map((r) => ({
        consentId: r.id,
        typeKey: r.typeKey as ConsentTypeKey,
        status: r.status,
        survivesDeath: r.survivesDeath,
        terminatesOnDeath: consentTerminatesOnDeath(r.typeKey as ConsentTypeKey, r.survivesDeath),
      }));
    },

    async listEvalAudit(organizationId, filter, page): Promise<CursorPage<EvalAuditRow>> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const where: (SQL | undefined)[] = [eq(CEA.organizationId, organizationId)];
        if (filter.consentId) where.push(eq(CEA.consentRecordId, filter.consentId));
        if (filter.patientId) where.push(eq(CEA.patientId, filter.patientId));
        if (page.cursor) {
          const c = decodeCursor(page.cursor);
          // Keyset (evaluated_at, id) DESC — strictly after the cursor (§4.12, never an offset).
          if (c) where.push(sql`(${CEA.evaluatedAt}, ${CEA.id}) < (${c.sortKey}, ${c.id})`);
        }
        const rows = await tx
          .select({
            id: CEA.id,
            organizationId: CEA.organizationId,
            patientId: CEA.patientId,
            consentRecordId: CEA.consentRecordId,
            typeKey: CEA.typeKey,
            allowed: CEA.allowed,
            denyReason: CEA.denyReason,
            callerModule: CEA.callerModule,
            evaluatedAt: CEA.evaluatedAt,
          })
          .from(CEA)
          .where(and(...where))
          .orderBy(desc(CEA.evaluatedAt), desc(CEA.id))
          .limit(page.pageSize + 1);
        const hasMore = rows.length > page.pageSize;
        const pageRows: EvalAuditRow[] = rows.slice(0, page.pageSize).map((r) => ({
          id: r.id,
          organizationId: r.organizationId,
          patientId: r.patientId,
          consentRecordId: r.consentRecordId,
          typeKey: r.typeKey as ConsentTypeKey,
          allowed: r.allowed,
          denyReason: r.denyReason,
          callerModule: r.callerModule,
          evaluatedAt: r.evaluatedAt.toISOString(),
        }));
        const nextCursor =
          hasMore && pageRows.length > 0 ? encodeCursor(pageRows[pageRows.length - 1]!) : null;
        return { rows: pageRows, nextCursor };
      });
    },
  };
}
