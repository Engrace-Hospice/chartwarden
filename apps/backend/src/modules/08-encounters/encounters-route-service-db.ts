// apps/backend/src/modules/08-encounters — PRODUCTION EncounterRouteService, READ-first (M8L-T01).
//
// The screen-driving READS (encounter detail, the org encounter list, the cosignature queue, my open
// drafts, billability, signed-since, and the cosignature-request status) run as real Drizzle queries over
// the M8-owned tables inside `withOrgContext`, so RLS scopes every row by `app.org_id` as the unprivileged
// `wardenx_app` role. The full WRITE lifecycle (draft → vitals/mileage → finalize → sign → cosign →
// addendum, with optimistic concurrency + the `m8.*` outbox + the §7.4 D1 F2F dual-write) is the M8L-T02+
// follow-up; every write here fail-closes 501 (`NOT_IMPLEMENTED`) so the interface is satisfied and the
// mount is real. The in-memory `createInMemoryEncounterBackend` (`routes/service.ts`) stays the behavioral
// reference for those writes. NOTE: the `encounter` table is partitioned — reads query the parent normally.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { NotFoundError, WardenXError } from "@wardenx/types";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { CosignatureState } from "./cosignature/index";
import type {
  EncounterAbacFacts,
  EncounterAbacResolver,
  EncounterRouteService,
  EncounterView,
} from "./routes/service";

const ENC = schema.encounters;
const COSIGN = schema.cosignatureRequests;

/** A never-returning stub for the write lifecycle still owed by M8L-T02+. */
const notImpl = (): never => {
  throw new WardenXError(
    "NOT_IMPLEMENTED",
    "encounter writes arrive in M8L-T02+ (the Drizzle write lifecycle)",
    501,
  );
};

/** The encounter columns every read projects (single source of truth for {@link toView}). */
const encounterCols = {
  id: ENC.id,
  organizationId: ENC.organizationId,
  patientId: ENC.patientId,
  admissionId: ENC.admissionId,
  visitId: ENC.visitId,
  encounterType: ENC.encounterType,
  discipline: ENC.discipline,
  serviceDate: ENC.serviceDate,
  status: ENC.status,
  lateEntryTier: ENC.lateEntryTier,
  version: ENC.version,
  authoredByMembershipId: ENC.authoredByMembershipId,
  faceToFaceEncounterId: ENC.faceToFaceEncounterId,
  signedAt: ENC.signedAt,
  cosignedAt: ENC.cosignedAt,
} as const;

type EncounterRow = {
  id: string;
  organizationId: string;
  patientId: string;
  admissionId: string;
  visitId: string | null;
  encounterType: EncounterView["encounterType"];
  discipline: EncounterView["discipline"];
  serviceDate: string;
  status: EncounterView["status"];
  lateEntryTier: string;
  version: number;
  authoredByMembershipId: string;
  faceToFaceEncounterId: string | null;
  signedAt: Date | string | null;
  cosignedAt: Date | string | null;
};

/** Timestamptz → ISO string (drizzle returns a Date for `withTimezone` columns); mirror the in-memory shape. */
const iso = (v: Date | string | null): string | null =>
  v === null ? null : typeof v === "string" ? v : v.toISOString();

/** Project a real `encounter` row to the EXACT in-memory {@link EncounterView} shape. */
const toView = (r: EncounterRow): EncounterView => ({
  id: r.id,
  organizationId: r.organizationId,
  patientId: r.patientId,
  admissionId: r.admissionId,
  visitId: r.visitId,
  encounterType: r.encounterType,
  discipline: r.discipline,
  serviceDate: r.serviceDate as EncounterView["serviceDate"],
  status: r.status,
  lateEntryTier: r.lateEntryTier,
  version: Number(r.version),
  // The in-memory record keys the author by user id; the DB column is the authoring `membership` id.
  authoredByUserId: r.authoredByMembershipId,
  // Mirrors the in-memory `isF2f` derivation (§7.4 D1): the F2F encounter type OR a linked M6 F2F row.
  isF2f: r.encounterType === "face_to_face" || r.faceToFaceEncounterId !== null,
  signedAt: iso(r.signedAt),
  cosignedAt: iso(r.cosignedAt),
});

/**
 * The production, RLS-backed EncounterRouteService. Reads are real; writes fail-closed 501.
 * Org is bound from the request context by the caller and passed as `organizationId` — never the body.
 */
export function createDbEncounterRouteService(db: DbClient): EncounterRouteService {
  /** Load one org-scoped encounter row → the shared projection, or `null` when absent/cross-tenant. */
  async function loadRow(organizationId: string, encounterId: string): Promise<EncounterRow | null> {
    return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const [r] = await tx
        .select(encounterCols)
        .from(ENC)
        .where(eq(ENC.id, encounterId))
        .limit(1);
      return (r as EncounterRow | undefined) ?? null;
    });
  }

  return {
    // ── Encounter reads ────────────────────────────────────────────────────────────────────────────
    async getEncounter(organizationId, encounterId) {
      const r = await loadRow(organizationId, encounterId);
      if (!r) throw new NotFoundError("encounter"); // non-leaking 404 (mirrors the in-memory `load`)
      return toView(r);
    },
    async renderPayload(organizationId, encounterId) {
      const r = await loadRow(organizationId, encounterId);
      if (!r) throw new NotFoundError("encounter");
      // The assembled HearthNote render arrives with the M8L-T02+ write/assembly lifecycle; empty for now.
      return { encounterId: r.id, final: "" };
    },
    async listEncounters(organizationId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const rows = (await tx
          .select(encounterCols)
          .from(ENC)
          .orderBy(desc(ENC.serviceDate), desc(ENC.id))) as EncounterRow[];
        return { encounters: rows.map(toView) };
      });
    },
    async cosignatureQueue(organizationId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const rows = (await tx
          .select(encounterCols)
          .from(ENC)
          .where(eq(ENC.status, "cosign_pending"))
          .orderBy(desc(ENC.signedAt), desc(ENC.id))) as EncounterRow[];
        return { encounters: rows.map(toView) };
      });
    },
    async myDrafts(organizationId, actorUserId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const rows = (await tx
          .select(encounterCols)
          .from(ENC)
          .where(and(eq(ENC.status, "draft"), eq(ENC.authoredByMembershipId, actorUserId)))
          .orderBy(desc(ENC.serviceDate), desc(ENC.id))) as EncounterRow[];
        return { encounters: rows.map(toView) };
      });
    },
    async billable(organizationId, encounterIds) {
      if (encounterIds.length === 0) return { billability: [] };
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const rows = (await tx
          .select({ id: ENC.id, status: ENC.status })
          .from(ENC)
          .where(inArray(ENC.id, [...encounterIds]))) as { id: string; status: string }[];
        return {
          billability: rows.map((r) => ({
            encounterId: r.id,
            billable: r.status === "signed" || r.status === "cosigned",
          })),
        };
      });
    },
    async signedSince(organizationId, since) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const rows = (await tx
          .select(encounterCols)
          .from(ENC)
          .where(gte(ENC.signedAt, new Date(since)))
          .orderBy(desc(ENC.signedAt), desc(ENC.id))) as EncounterRow[];
        return { encounters: rows.map(toView) };
      });
    },

    // ── Cosignature-request read (status derived from the D3 workflow row) ────────────────────────────
    async getCosignature(organizationId, encounterId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [enc] = await tx.select({ id: ENC.id }).from(ENC).where(eq(ENC.id, encounterId)).limit(1);
        if (!enc) throw new NotFoundError("encounter"); // mirror the in-memory `load` (404 before status)
        const [cr] = await tx
          .select({ status: COSIGN.status })
          .from(COSIGN)
          .where(eq(COSIGN.encounterId, encounterId))
          .limit(1);
        // No request row → no cosignature workflow yet (the in-memory slice returns `null`).
        return { status: cr ? (cr.status as CosignatureState) : null };
      });
    },

    // ── Writes — the M8L-T02+ Drizzle lifecycle. Fail-closed 501 until then. ──────────────────────────
    createDraft: async () => notImpl(),
    updateSelections: async () => notImpl(),
    captureVitals: async () => notImpl(),
    editVitals: async () => notImpl(),
    captureMileage: async () => notImpl(),
    editMileage: async () => notImpl(),
    addCarePlanLink: async () => notImpl(),
    removeCarePlanLink: async () => notImpl(),
    documentEvvMissing: async () => notImpl(),
    finalize: async () => notImpl(),
    enhanceHearthnote: async () => notImpl(),
    recordModificationDecision: async () => notImpl(),
    sign: async () => notImpl(),
    lateEntryOverride: async () => notImpl(),
    administrativeOverride: async () => notImpl(),
    voidEncounter: async () => notImpl(),
    cosignAcknowledge: async () => notImpl(),
    cosignSign: async () => notImpl(),
    supervisorRelease: async () => notImpl(),
    createAddendum: async () => notImpl(),
    updateAddendumSelections: async () => notImpl(),
    finalizeAddendum: async () => notImpl(),
    signAddendum: async () => notImpl(),
  };
}

/**
 * The production, RLS-backed EncounterAbacResolver — M8's §4.6 `cosigner_role_match` predicate loads the
 * encounter's author + discipline facts through it. The load is a single org-scoped read under
 * `withOrgContext` (RLS backstops), returning `null` when the row is absent/cross-tenant so the predicate
 * fails closed (no self-cosign is decided against the real `authored_by_membership_id`).
 */
export function createDbEncounterAbacResolver(db: DbClient): EncounterAbacResolver {
  return {
    async loadEncounter(organizationId, encounterId): Promise<EncounterAbacFacts | null> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .select({
            id: ENC.id,
            patientId: ENC.patientId,
            discipline: ENC.discipline,
            authoredByMembershipId: ENC.authoredByMembershipId,
          })
          .from(ENC)
          .where(eq(ENC.id, encounterId))
          .limit(1);
        return r
          ? {
              encounterId: r.id,
              patientId: r.patientId,
              discipline: r.discipline as EncounterAbacFacts["discipline"],
              authoredByUserId: r.authoredByMembershipId,
            }
          : null;
      });
    },
  };
}
