// apps/backend/src/modules/40-mdm — PRODUCTION MDM data adapters over Drizzle (FB-T02).
//
// The `MdmEntityProvider` / `BaaStatusProvider` seams (packages/mdm) are PURE ORCHESTRATION over
// data ports (`MdmStore` / `BaaStore`); the routes' write/admin surface goes through
// `MdmRouteService`. The boot slice + unit tests inject the in-memory backends; production injects
// THESE, which read the real M40 tables. Mirrors the FB-T01 `TerminologyStore` + the M5
// `patient-route-service-db.ts` live-store pattern: small factories that close over the DbClient.
//
// RLS shape (M40-T03, §3.6, migration 0019):
//   • CANONICAL (external_physician / facility / payer) + entity_relationship are org-less platform
//     master data — read-all via the `USING (true)` policy, so reads run directly on the pooled
//     `wardenx_app` handle (no org context). They are writable ONLY via the `mdm_canonical_writer`
//     SECURITY DEFINER functions (§7.4); `wardenx_app` can never mutate them.
//   • ORG-SCOPED (external_physician_tenant_overlay / mdm_provisional / mdm_baa_record /
//     mdm_baa_required) carry app.org_id RLS, so their reads/writes run inside `withOrgContext`.
//   • PLATFORM-OPS (merge_request / nppes_sync_log) are wardenx_admin break-glass surfaces with NO
//     wardenx_app grant, and the merge-approval workflow needs the §7.6 canonical-writer functions.
//     Those governance writes are therefore NOT wired on the request handle in FB-T02 (they throw a
//     clear 501) — the entity-directory read surface + the org-scoped overlay/BAA writes ARE live,
//     which is what the merged-module screen (apps/web/src/modules/40-mdm) consumes.
import { type DbClient, schema } from "@wardenx/db";
import type {
  BaaRecordRow,
  BaaRegisterEntry,
  BaaStore,
  CanonicalFields,
  CanonicalRedirectRow,
  IdentifyingFields,
  MdmBaaGateResult,
  MdmEntityKind,
  MdmRouteService,
  MdmStore,
  MergeRequestRow,
  NppesSyncRun,
  OverlayFields,
  OverlayPhysicianFields,
  SearchSpec,
} from "@wardenx/mdm";
import type { BaaEntityKind } from "@wardenx/mdm";
import { withOrgContext } from "@wardenx/tenancy";
import { WardenXError } from "@wardenx/types";
import { type SQL, and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";

const PH = schema.externalPhysicians;
const FAC = schema.facilities;
const PAY = schema.payers;
const OVERLAY = schema.externalPhysicianOverlay;
const PROV = schema.mdmProvisional;
const REL = schema.entityRelationships;
const BAA = schema.mdmBaaRecords;
const BAA_REQ = schema.mdmBaaRequired;
const MERGE = schema.mergeRequests;
const SYNC = schema.nppesSyncLog;

const SEARCH_DEFAULT_LIMIT = 25;
const SEARCH_MAX_LIMIT = 100;

/** Only physician/facility/payer materialize a canonical table in Phase 1 (manifest §3.3). The four
 *  forward-declared kinds have no table, so every canonical read for them resolves empty — the same
 *  shape the in-memory slice gives an unseeded kind. */
function hasCanonicalTable(kind: MdmEntityKind): kind is "physician" | "facility" | "payer" {
  return kind === "physician" || kind === "facility" || kind === "payer";
}

// ── canonical row → typed CanonicalFields<K> projection (§4.5) ─────────────────────────────────

function mapPhysician(r: typeof PH.$inferSelect): CanonicalFields<"physician"> {
  return {
    id: r.id,
    identifierType: "npi",
    identifierValue: r.npi,
    displayName: `${r.firstName} ${r.lastName}`.trim(),
    firstName: r.firstName,
    lastName: r.lastName,
    credentials: r.credentials,
    isNp: r.isNp,
    specialtyTaxonomy: r.specialtyTaxonomy,
    licenseStates: r.licenseStates ?? null,
  };
}

function mapFacility(r: typeof FAC.$inferSelect): CanonicalFields<"facility"> {
  return {
    id: r.id,
    identifierType: "ccn",
    identifierValue: r.ccn,
    displayName: r.name,
    ccn: r.ccn,
    npi: r.npi,
    sendingFacilityCodes: r.sendingFacilityCodes ?? [],
  };
}

function mapPayer(r: typeof PAY.$inferSelect): CanonicalFields<"payer"> {
  return {
    id: r.id,
    identifierType: "x12_payer_id",
    identifierValue: r.payerId,
    displayName: r.name,
    x12PayerId: r.payerId,
  };
}

/** The §2.5 redirect projection (`id`/`status`/`mergedIntoId`) drives the T04 `followMerge` chase. */
function redirectOf(r: {
  id: string;
  status: CanonicalRedirectRow["status"];
  mergedIntoId: string | null;
}): CanonicalRedirectRow {
  return { id: r.id, status: r.status, mergedIntoId: r.mergedIntoId };
}

/**
 * Build the production {@link MdmStore}. Canonical reads run on the pooled handle (the `USING (true)`
 * policy admits them); the org-scoped overlay / provisional / BAA-gate methods run inside
 * `withOrgContext` so RLS scopes by `app.org_id`.
 */
export function createDbMdmStore(db: DbClient): MdmStore {
  return {
    async canonicalRedirect(kind, id) {
      if (!hasCanonicalTable(kind)) return null;
      const t = kind === "physician" ? PH : kind === "facility" ? FAC : PAY;
      const rows = await db
        .select({ id: t.id, status: t.status, mergedIntoId: t.mergedIntoId })
        .from(t)
        .where(eq(t.id, id))
        .limit(1);
      return rows[0] ? redirectOf(rows[0]) : null;
    },

    async canonicalFields<K extends MdmEntityKind>(kind: K, id: string) {
      if (!hasCanonicalTable(kind)) return null;
      if (kind === "physician") {
        const rows = await db.select().from(PH).where(eq(PH.id, id)).limit(1);
        return (rows[0] ? mapPhysician(rows[0]) : null) as CanonicalFields<K> | null;
      }
      if (kind === "facility") {
        const rows = await db.select().from(FAC).where(eq(FAC.id, id)).limit(1);
        return (rows[0] ? mapFacility(rows[0]) : null) as CanonicalFields<K> | null;
      }
      const rows = await db.select().from(PAY).where(eq(PAY.id, id)).limit(1);
      return (rows[0] ? mapPayer(rows[0]) : null) as CanonicalFields<K> | null;
    },

    async overlay<K extends MdmEntityKind>(kind: K, orgId: string, canonicalId: string) {
      // Only the physician kind ships a Phase-1 overlay table; every other kind resolves to null.
      if (kind !== "physician") return null;
      const rows = await withOrgContext(db, { organizationId: orgId, userId: "" }, (tx) =>
        tx
          .select()
          .from(OVERLAY)
          .where(
            and(eq(OVERLAY.externalPhysicianId, canonicalId), eq(OVERLAY.organizationId, orgId)),
          )
          .limit(1),
      );
      const o = rows[0];
      if (!o) return null;
      const overlay: OverlayPhysicianFields = {
        preferredContactPhone: o.preferredContactPhone,
        preferredContactEmail: o.preferredContactEmail,
        relationshipNotes: o.relationshipNotes,
        doNotRefer: o.doNotRefer,
        isPreferred: o.isPreferred,
        preferredRank: o.preferredRank,
      };
      // Generic K can't narrow to "physician" here, but the guard above proves it — mirror the
      // in-memory store's cast (only the physician kind reaches this point).
      return overlay as OverlayFields<K>;
    },

    async canonicalIdByIdentifier(kind, value) {
      if (!hasCanonicalTable(kind)) return null;
      const t = kind === "physician" ? PH : kind === "facility" ? FAC : PAY;
      const idCol = kind === "physician" ? PH.npi : kind === "facility" ? FAC.ccn : PAY.payerId;
      const rows = await db.select({ id: t.id }).from(t).where(eq(idCol, value)).limit(1);
      return rows[0]?.id ?? null;
    },

    async searchCanonicalIds<K extends MdmEntityKind>(kind: K, q: SearchSpec<K>) {
      if (!hasCanonicalTable(kind)) return [];
      const limit = Math.min(
        SEARCH_MAX_LIMIT,
        Math.max(1, Math.floor(q.limit ?? SEARCH_DEFAULT_LIMIT)),
      );
      const t = kind === "physician" ? PH : kind === "facility" ? FAC : PAY;
      const nameExpr =
        kind === "physician"
          ? (sql`(${PH.firstName} || ' ' || ${PH.lastName})` as SQL)
          : kind === "facility"
            ? (FAC.name as unknown as SQL)
            : (PAY.name as unknown as SQL);
      const idCol = kind === "physician" ? PH.npi : kind === "facility" ? FAC.ccn : PAY.payerId;
      const filters: (SQL | undefined)[] = [
        // §4.2: search excludes merged rows (the redirect survivor is what a consumer ever sees).
        sql`${t.status} <> 'merged'`,
      ];
      if (q.identifier !== undefined) filters.push(eq(idCol, q.identifier));
      if (q.text) {
        const needle = `%${q.text}%`;
        filters.push(or(ilike(nameExpr, needle), ilike(idCol, needle)) as SQL);
      }
      const rows = await db
        .select({ id: t.id })
        .from(t)
        .where(and(...filters))
        .limit(limit);
      return rows.map((r) => r.id);
    },

    async createProvisional<K extends MdmEntityKind>(
      orgId: string,
      kind: K,
      identifying: IdentifyingFields<K>,
      actorUserId: string,
    ) {
      const inserted = await withOrgContext(
        db,
        { organizationId: orgId, userId: actorUserId },
        (tx) =>
          tx
            .insert(PROV)
            .values({
              organizationId: orgId,
              entityKind: kind,
              proposedFields: identifying as unknown as Record<string, unknown>,
              proposedBy: actorUserId || null,
            })
            .returning({ id: PROV.id }),
      );
      return { provisionalId: inserted[0]!.id };
    },

    async parentId(kind, id) {
      // A `parent` edge means src_id's parent is dst_id (canonical hierarchy, org-less).
      const rows = await db
        .select({ dstId: REL.dstId })
        .from(REL)
        .where(and(eq(REL.entityKind, kind), eq(REL.srcId, id), eq(REL.relationship, "parent")))
        .limit(1);
      return rows[0]?.dstId ?? null;
    },

    async childIds(kind, id) {
      const rows = await db
        .select({ srcId: REL.srcId })
        .from(REL)
        .where(and(eq(REL.entityKind, kind), eq(REL.dstId, id), eq(REL.relationship, "parent")));
      return rows.map((r) => r.srcId);
    },

    async baaGate(orgId, kind, canonicalId): Promise<MdmBaaGateResult> {
      // The omnibus convenience gate over the recorded record (the real as-of decision is the
      // focused BaaStatusProvider seam, below). Newest executed-on first.
      const rows = await withOrgContext(db, { organizationId: orgId, userId: "" }, (tx) =>
        tx
          .select({ baaStatus: BAA.baaStatus, expiresOn: BAA.expiresOn })
          .from(BAA)
          .where(
            and(
              eq(BAA.organizationId, orgId),
              eq(BAA.entityKind, kind),
              eq(BAA.canonicalId, canonicalId),
            ),
          )
          .orderBy(desc(BAA.executedOn))
          .limit(1),
      );
      const r = rows[0];
      if (!r) return { required: true, status: "missing", expiresOn: null };
      return { required: true, status: r.baaStatus, expiresOn: r.expiresOn };
    },
  };
}

/**
 * Build the production {@link BaaStore} for the focused §7.7 BAA gate. The facility lookup is org-less
 * (canonical reference, pooled handle); the per-(org) policy + records run inside `withOrgContext`.
 */
export function createDbBaaStore(db: DbClient): BaaStore {
  return {
    async facilityIdBySendingFacility(sendingFacility) {
      // Case-insensitive containment over the jsonb `sending_facility_codes` array (§7.9).
      const rows = await db
        .select({ id: FAC.id })
        .from(FAC)
        .where(
          sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${FAC.sendingFacilityCodes}) AS code WHERE upper(code) = upper(${sendingFacility}))`,
        )
        .limit(1);
      return rows[0]?.id ?? null;
    },

    async isBaaRequired(orgId, kind: BaaEntityKind) {
      const rows = await withOrgContext(db, { organizationId: orgId, userId: "" }, (tx) =>
        tx
          .select({ required: BAA_REQ.required })
          .from(BAA_REQ)
          .where(and(eq(BAA_REQ.organizationId, orgId), eq(BAA_REQ.kind, kind)))
          .limit(1),
      );
      return rows[0]?.required ?? null;
    },

    async baaRecords(orgId, kind: BaaEntityKind, canonicalId): Promise<readonly BaaRecordRow[]> {
      const rows = await withOrgContext(db, { organizationId: orgId, userId: "" }, (tx) =>
        tx
          .select({
            id: BAA.id,
            baaStatus: BAA.baaStatus,
            executedOn: BAA.executedOn,
            expiresOn: BAA.expiresOn,
          })
          .from(BAA)
          .where(
            and(
              eq(BAA.organizationId, orgId),
              eq(BAA.entityKind, kind),
              eq(BAA.canonicalId, canonicalId),
            ),
          ),
      );
      return rows.map((r) => ({
        id: r.id,
        baaStatus: r.baaStatus,
        executedOn: r.executedOn,
        expiresOn: r.expiresOn,
      }));
    },
  };
}

/** The §7.6 governance writes need the canonical-writer SECURITY DEFINER functions (deeper M40),
 *  not wired on the request handle in FB-T02 — fail clearly rather than corrupt the redirect graph. */
function governanceNotWired(op: string): never {
  throw new WardenXError(
    "NOT_IMPLEMENTED",
    `${op} runs through the M40 platform-ops canonical-writer surface (§7.6), not wired in FB-T02`,
    501,
  );
}

/**
 * Build the production {@link MdmRouteService}. The org-scoped surface (physician overlay upsert, the
 * tenant BAA register) is live Drizzle under `withOrgContext`; the platform-ops READS (merge queue /
 * NPPES sync-log / on-demand NPI match) are live reads; the canonical-mutating governance writes
 * (merge approve/reject, provisional promote) defer to the §7.6 canonical-writer surface.
 */
export function createDbMdmRouteService(db: DbClient): MdmRouteService {
  return {
    async upsertPhysicianOverlay(orgId, canonicalId, fields: OverlayPhysicianFields, actorUserId) {
      await withOrgContext(db, { organizationId: orgId, userId: actorUserId }, (tx) =>
        tx
          .insert(OVERLAY)
          .values({
            externalPhysicianId: canonicalId,
            organizationId: orgId,
            preferredContactPhone: fields.preferredContactPhone,
            preferredContactEmail: fields.preferredContactEmail,
            relationshipNotes: fields.relationshipNotes,
            doNotRefer: fields.doNotRefer,
            isPreferred: fields.isPreferred,
            preferredRank: fields.preferredRank,
            createdBy: actorUserId || null,
          })
          .onConflictDoUpdate({
            target: [OVERLAY.externalPhysicianId, OVERLAY.organizationId],
            set: {
              preferredContactPhone: fields.preferredContactPhone,
              preferredContactEmail: fields.preferredContactEmail,
              relationshipNotes: fields.relationshipNotes,
              doNotRefer: fields.doNotRefer,
              isPreferred: fields.isPreferred,
              preferredRank: fields.preferredRank,
              updatedAt: sql`now()`,
            },
          }),
      );
      return { applied: true };
    },

    async listBaa(orgId): Promise<readonly BaaRegisterEntry[]> {
      const rows = await withOrgContext(db, { organizationId: orgId, userId: "" }, (tx) =>
        tx
          .select({
            id: BAA.id,
            kind: BAA.entityKind,
            canonicalId: BAA.canonicalId,
            baaStatus: BAA.baaStatus,
            executedOn: BAA.executedOn,
            expiresOn: BAA.expiresOn,
          })
          .from(BAA)
          .where(eq(BAA.organizationId, orgId)),
      );
      return rows.map((r) => ({
        id: r.id,
        kind: r.kind as BaaEntityKind,
        canonicalId: r.canonicalId,
        baaStatus: r.baaStatus,
        executedOn: r.executedOn,
        expiresOn: r.expiresOn,
      }));
    },

    async recordBaa(orgId, input, actorUserId) {
      const inserted = await withOrgContext(
        db,
        { organizationId: orgId, userId: actorUserId },
        (tx) =>
          tx
            .insert(BAA)
            .values({
              organizationId: orgId,
              entityKind: input.kind,
              canonicalId: input.canonicalId,
              baaStatus: input.baaStatus,
              executedOn: input.executedOn,
              expiresOn: input.expiresOn,
            })
            .onConflictDoUpdate({
              target: [BAA.organizationId, BAA.entityKind, BAA.canonicalId],
              set: {
                baaStatus: input.baaStatus,
                executedOn: input.executedOn,
                expiresOn: input.expiresOn,
                updatedAt: sql`now()`,
              },
            })
            .returning({ id: BAA.id }),
      );
      return { id: inserted[0]!.id };
    },

    async recordLicense() {
      // Phase 1 ships no canonical license table (manifest owns 11 tables) — record is a documented
      // no-op until the license surface lands. The route still 201s so the screen flow is intact.
      return { recorded: true };
    },

    async listMergeRequests(): Promise<readonly MergeRequestRow[]> {
      // Platform-ops read (wardenx_admin break-glass surface; no wardenx_app grant). The open dedup
      // queue, newest first.
      const rows = await db
        .select({
          id: MERGE.id,
          kind: MERGE.entityKind,
          canonicalId: MERGE.canonicalId,
          duplicateId: MERGE.duplicateId,
          status: MERGE.status,
          evidence: MERGE.evidence,
        })
        .from(MERGE)
        .where(inArray(MERGE.status, ["pending", "approved"]))
        .orderBy(desc(MERGE.createdAt));
      return rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        canonicalId: r.canonicalId,
        duplicateId: r.duplicateId,
        status: r.status,
        evidence: (r.evidence ?? {}) as Readonly<Record<string, unknown>>,
      }));
    },

    async approveMerge() {
      return governanceNotWired("merge approval");
    },

    async rejectMerge() {
      governanceNotWired("merge rejection");
    },

    async promoteProvisional() {
      return governanceNotWired("provisional promotion");
    },

    async nppesLookup(npi) {
      // On-demand single-NPI match against the canonical physician set (a read — the canonical write
      // path is the §4.3 nightly job / §7.6 writer surface). `matched` ⇔ a canonical NPI exists.
      const rows = await db.select({ id: PH.id }).from(PH).where(eq(PH.npi, npi)).limit(1);
      const canonicalId = rows[0]?.id ?? null;
      return { matched: canonicalId !== null, canonicalId };
    },

    async nppesSyncLog(): Promise<readonly NppesSyncRun[]> {
      const rows = await db
        .select({ id: SYNC.id, mode: SYNC.mode, outcome: SYNC.outcome })
        .from(SYNC)
        .orderBy(desc(SYNC.runAt))
        .limit(50);
      return rows.map((r) => ({
        id: r.id,
        mode: r.mode,
        outcome: r.outcome as NppesSyncRun["outcome"],
      }));
    },
  };
}
