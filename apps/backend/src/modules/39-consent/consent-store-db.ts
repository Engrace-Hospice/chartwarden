import {
  type ConsentCaptureMethod,
  type ConsentCatalogView,
  type ConsentEvaluator,
  type ConsentGrantorKind,
  type ConsentRecordView,
  type ConsentRouteService,
  type ConsentStore,
  type ConsentTypeKey,
  type CursorPage,
  type EvalAuditRow,
  type RecipientResolvedKind,
  type StoredConsent,
  type StoredRecipient,
  createConsentEvaluator,
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
import { type SQL, and, desc, eq, inArray, sql } from "drizzle-orm";

const CR = schema.consentRecord;
const CRR = schema.consentRecordRecipient;
const CAT = schema.consentTypeCatalog;
const CEA = schema.consentEvalAudit;

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

/** Encode/decode the opaque keyset cursor (`evaluatedAt|id`), mirroring the in-memory slice (§4.12 —
 *  never an offset). */
function encodeCursor(row: EvalAuditRow): string {
  return Buffer.from(`${row.evaluatedAt}|${row.id}`, "utf8").toString("base64url");
}
function decodeCursor(cursor: string): { evaluatedAt: string; id: string } | null {
  try {
    const [evaluatedAt, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    if (!evaluatedAt || !id) return null;
    return { evaluatedAt, id };
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

    async listEvalAudit(organizationId, filter, page): Promise<CursorPage<EvalAuditRow>> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const where: (SQL | undefined)[] = [eq(CEA.organizationId, organizationId)];
        if (filter.consentId) where.push(eq(CEA.consentRecordId, filter.consentId));
        if (filter.patientId) where.push(eq(CEA.patientId, filter.patientId));
        if (page.cursor) {
          const c = decodeCursor(page.cursor);
          // Keyset (evaluated_at, id) DESC — strictly after the cursor (§4.12, never an offset).
          if (c) where.push(sql`(${CEA.evaluatedAt}, ${CEA.id}) < (${c.evaluatedAt}, ${c.id})`);
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
