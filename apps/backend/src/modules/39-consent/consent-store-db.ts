import {
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
  recipientActive,
  validateConsentOverlay,
  validateRecipientFk,
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
// SCOPE (FB-T03): the consent READ surface the merged-module screen consumes is live — the catalog,
// the patient's active consents (the Patient Chart consent tab, FB-T10), a single record, and the
// cursor-paginated decision audit. The consent-LIFECYCLE writes (create-draft / sign / revoke) need
// the deeper §2.2.1 machinery (capture-evidence + step-up evidence linkage, the append-only
// supersession chain D1/D5, per-tenant DEK encryption of internal notes) that the naive route slice
// cannot honor without corrupting the append-only invariants — they fail clear with a 501 pointing at
// the M39 consent-flow surface (T09), exactly as FB-T02 deferred the canonical-mutating MDM writes.
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

/** The `consent_recipient_kind` values that are also a resolved disclosure-target class (§4.3). The
 *  evaluator matches by id, not kind, so the extra DB kinds (attorney/employer/free_text) carry no
 *  resolved kind — `undefined` is the same shape the in-memory slice gives an unkinded recipient. */
const RESOLVED_KINDS = new Set<string>([
  "external_physician",
  "facility",
  "pharmacy",
  "irb",
  "family_member",
  "researcher",
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
      // M5 owns the truth; D13 post-death scope arrives via the `m5.patient.deceased` OUTBOX consumer
      // (M39-T08), NOT a PatientReader call (PatientReader exposes no deceased signal — see
      // consumed-seams.ts). That consumer + its M1 infra are not yet wired, so this returns false —
      // the same shape the in-memory slice gives a patient absent from its deceased set.
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

/** The consent-lifecycle writes need the deeper §2.2.1 flow (capture/step-up evidence, the append-only
 *  supersession chain, per-tenant DEK encryption), not wired on the request handle in FB-T03 — fail
 *  clear rather than write a half-formed append-only consent record. */
function lifecycleNotWired(op: string): never {
  throw new WardenXError(
    "NOT_IMPLEMENTED",
    `${op} runs through the M39 consent-flow surface (§2.2.1; capture/step-up evidence + DEK), not wired in FB-T03`,
    501,
  );
}

/** The two routes whose whole effect is an OUTBOX republish (re-render → M22, cascade retry → the
 *  §2.2.3 consumers). With no dispatcher bound, a 202 receipt would promise work nobody performs. */
function outboxNotWired(op: string): never {
  throw new WardenXError(
    "NOT_IMPLEMENTED",
    `${op} republishes through the M1 transactional outbox, which is not bound on this handle`,
    501,
  );
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
 * Build the production {@link ConsentRouteService}. The READ surface (catalog, the patient's active
 * consents, a single record, the cursor-paginated decision audit) is live Drizzle — the catalog on
 * the pooled handle, the org-scoped reads inside `withOrgContext`. The lifecycle WRITES defer to the
 * §2.2.1 consent-flow surface (501).
 */
export function createDbConsentRouteService(db: DbClient): ConsentRouteService {
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

    async createDraft() {
      return lifecycleNotWired("consent draft creation");
    },

    async signConsent() {
      return lifecycleNotWired("consent signing");
    },

    async revokeConsent() {
      return lifecycleNotWired("consent revocation");
    },

    // Every write below that MINTS OR MUTATES a `consent_record` row shares the createDraft
    // blocker — the §2.2.1 capture/step-up evidence + the per-tenant DEK for `internal_notes_cipher`
    // are unwired on the request handle. Writing them half-formed would corrupt an append-only,
    // legally-operative record, so they fail clear. The CHILD-row writes (recipients, DPOA agents,
    // the tenant overlay) carry neither the DEK nor the supersession chain and ARE live below.
    async updateDraft() {
      return lifecycleNotWired("consent draft editing");
    },

    async supersedeConsent() {
      return lifecycleNotWired("consent supersession");
    },

    async renewConsent() {
      return lifecycleNotWired("consent renewal");
    },

    async createBereavementOutreachDraft() {
      return lifecycleNotWired("bereavement-outreach consent capture");
    },

    // Both of these are OUTBOX republish paths, not data writes: re-render re-emits
    // `m39.consent.signed` for M22, and the cascade retry re-dispatches to the §2.2.3 consumers.
    // The transactional-outbox dispatcher is not bound on this handle, so returning a 202 receipt
    // would claim work that never happens.
    async requestDocumentReRender() {
      return outboxNotWired("consent document re-render");
    },

    async retryRevocationCascade() {
      return outboxNotWired("revocation-cascade retry");
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
            .select({ typeKey: CR.typeKey })
            .from(CR)
            .where(and(eq(CR.organizationId, organizationId), eq(CR.id, consentId)))
            .limit(1)
        )[0];
        if (!parent) throw new ConsentRouteError("not_found", "consent not found");
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
