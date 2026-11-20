// apps/backend/src/modules/09-assessments/wounds/service-db.ts — the PRODUCTION WoundRouteService over Drizzle + RLS.
// Every statement runs inside `withOrgContext`, so `app.org_id` scopes every row as the unprivileged `chartwarden_app`
// role; each query also names the organisation, a second wall behind RLS. Writes pass the acting user so the write-audit
// trigger attributes the row; reads are audited by the route's read-audit config. Observations are APPEND-ONLY (the M9
// convention): a correction INSERTs a superseding row and the database flips the corrected one; nothing is UPDATEd by
// this service but a wound's close. The wound row is locked (SHARE to observe, UPDATE to resolve) so an observation cannot
// slip in beside the resolve that closes its wound.
//
// An observation tied to a visit (`sourceEncounterId`) is checked against M8's `EncounterDraftReader` seam BEFORE the transaction opens (the
// seam has its own tenant context): the visit must be the caller's own note, for this patient, still being written (./source-visit.ts).
import {
  assertCorrectable,
  assertValidObservedAt,
  assertValidWound,
  assertValidWoundObservation,
  assertValidWoundResolution,
  assertWoundOpen,
} from "@chartwarden/assessments";
import { type DbClient, schema, todayForOrganization } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { type EncounterDraftReader, NotFoundError } from "@chartwarden/types";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  type WoundObservationRecord,
  observationValuesOf,
  toObservationDtos,
  toWoundView,
} from "./projection";
import { woundObservationRecordOf, woundRecordOf } from "./row-mappers";
import {
  MAX_OBSERVATIONS_LISTED,
  MAX_WOUNDS_LISTED,
  type WoundListItem,
  type WoundObservationDto,
  type WoundRouteService,
  type WoundView,
} from "./service";
import { assertOwnDraftVisit, seamEncounterDraftReader } from "./source-visit";

const W = schema.wounds;
const O = schema.woundObservations;

/** Current observations loaded to build a chart list (the newest first, so a cap drops only the oldest history). */
const MAX_LIST_OBSERVATIONS = 5000;

type Tx = DbClient;

export interface DbWoundServiceOptions {
  readonly now?: () => Date;
  /** M8's visit facts; defaults to the `EncounterDraftReader` seam (fail-closed deny-stub until M8 registers it). */
  readonly visits?: EncounterDraftReader;
}

export function createDbWoundService(
  db: DbClient,
  options: DbWoundServiceOptions = {},
): WoundRouteService {
  const now = options.now ?? (() => new Date());
  const visits = options.visits ?? seamEncounterDraftReader;
  const inOrg = <T>(
    organizationId: string,
    userId: string,
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T> => withOrgContext(db, { organizationId, userId }, (tx) => fn(tx as unknown as Tx));

  async function loadWound(
    tx: Tx,
    organizationId: string,
    patientId: string,
    woundId: string,
    lock?: "share" | "update",
  ) {
    const query = tx
      .select()
      .from(W)
      .where(
        and(eq(W.organizationId, organizationId), eq(W.patientId, patientId), eq(W.id, woundId)),
      )
      .limit(1);
    const [row] = await (lock ? query.for(lock) : query);
    if (!row) throw new NotFoundError("wound");
    return woundRecordOf(row);
  }

  async function currentObservationDtos(
    tx: Tx,
    organizationId: string,
    woundId: string,
    includeSuperseded: boolean,
  ): Promise<WoundObservationDto[]> {
    const rows = await tx
      .select()
      .from(O)
      .where(
        and(
          eq(O.organizationId, organizationId),
          eq(O.woundId, woundId),
          includeSuperseded ? undefined : eq(O.status, "active"),
        ),
      )
      .orderBy(desc(O.observedAt), desc(O.id))
      .limit(MAX_OBSERVATIONS_LISTED);
    return toObservationDtos(rows.map(woundObservationRecordOf), { includeSuperseded });
  }

  async function insertObservation(
    tx: Tx,
    values: typeof O.$inferInsert,
    organizationId: string,
    woundId: string,
  ): Promise<WoundObservationDto> {
    const [row] = await tx.insert(O).values(values).returning({ id: O.id });
    if (!row) throw new Error("wound observation insert returned no row");
    const dto = (await currentObservationDtos(tx, organizationId, woundId, false)).find(
      (o) => o.id === row.id,
    );
    if (!dto) throw new NotFoundError("wound observation");
    return dto;
  }

  const assertVisitOpen = (
    actor: { organizationId: string; membershipId: string },
    patientId: string,
    encounterId: string,
  ): Promise<void> =>
    assertOwnDraftVisit(visits, {
      organizationId: actor.organizationId,
      encounterId,
      patientId,
      membershipId: actor.membershipId,
    });

  /**
   * The visit an observation is tied to now, after the same 404s a missing wound or observation answers (for THIS patient), so the visit check
   * never runs ahead of them. Read before the transaction so the seam can be asked outside it.
   */
  const taggedVisitOf = (
    actor: { organizationId: string; userId: string },
    patientId: string,
    woundId: string,
    observationId: string,
  ): Promise<string | null> =>
    inOrg(actor.organizationId, actor.userId, async (tx) => {
      await loadWound(tx, actor.organizationId, patientId, woundId);
      const [row] = await tx
        .select({ sourceEncounterId: O.sourceEncounterId })
        .from(O)
        .where(
          and(
            eq(O.organizationId, actor.organizationId),
            eq(O.patientId, patientId),
            eq(O.woundId, woundId),
            eq(O.id, observationId),
          ),
        )
        .limit(1);
      if (!row) throw new NotFoundError("wound observation");
      return row.sourceEncounterId;
    });

  /**
   * A visit can be finalized or voided between the seam check (before the transaction) and the commit, and the note then never states an
   * observation tied to it after the fact. So once committed the visit is asked again, and an observation tied to one that is no longer a
   * draft is taken out of it. The table is append-only, so that is a CORRECTION (`wrong_visit`) that supersedes it with no visit, returned
   * so the response shows `sourceEncounterId: null`: no 409 after a committed write, and the same answer on an idempotent replay.
   */
  async function untagIfVisitClosed(
    actor: { organizationId: string; userId: string; membershipId: string },
    patientId: string,
    committed: WoundObservationDto,
    checkedVisit: string | null,
  ): Promise<WoundObservationDto> {
    if (!checkedVisit || committed.sourceEncounterId !== checkedVisit) return committed;
    const facts = await visits.draftOf({
      organizationId: actor.organizationId,
      encounterId: checkedVisit,
    });
    if (facts?.status === "draft") return committed;
    return inOrg(actor.organizationId, actor.userId, async (tx) => {
      const wound = await loadWound(
        tx,
        actor.organizationId,
        patientId,
        committed.woundId,
        "share",
      );
      return insertObservation(
        tx,
        insertValuesOf(
          actor,
          wound,
          committed.observedAt,
          { ...committed, sourceEncounterId: null },
          { targetId: committed.id, reason: "wrong_visit" },
        ),
        actor.organizationId,
        wound.id,
      );
    });
  }

  const insertValuesOf = (
    actor: { organizationId: string; membershipId: string },
    wound: { id: string; patientId: string },
    observedAt: string,
    input: Parameters<typeof observationValuesOf>[0] & { sourceEncounterId?: string | null },
    correction?: { targetId: string; reason: string },
  ): typeof O.$inferInsert => {
    const v = observationValuesOf(input);
    return {
      organizationId: actor.organizationId,
      woundId: wound.id,
      patientId: wound.patientId,
      observedAt: new Date(observedAt),
      observedByMembershipId: actor.membershipId,
      sourceEncounterId: input.sourceEncounterId ?? null,
      stage: v.stage,
      lengthCm: v.lengthCm === null ? null : String(v.lengthCm),
      widthCm: v.widthCm === null ? null : String(v.widthCm),
      depthCm: v.depthCm === null ? null : String(v.depthCm),
      undermining: v.undermining,
      woundBed: [...v.woundBed],
      exudateAmount: v.exudateAmount,
      exudateType: v.exudateType,
      odor: v.odor,
      periwound: [...v.periwound],
      painScore: v.painScore,
      dressing: v.dressing,
      dressingChanged: v.dressingChanged,
      infectionSigns: v.infectionSigns,
      trend: v.trend,
      correctsObservationId: correction?.targetId ?? null,
      correctionReason: correction?.reason ?? null,
    };
  };

  return {
    async listWounds(organizationId, patientId, status) {
      return inOrg(organizationId, "", async (tx) => {
        const rows = await tx
          .select()
          .from(W)
          .where(
            and(
              eq(W.organizationId, organizationId),
              eq(W.patientId, patientId),
              status === "all" ? undefined : eq(W.status, status),
            ),
          )
          .orderBy(sql`(${W.status} = 'open') DESC`, desc(W.createdAt), asc(W.id))
          .limit(MAX_WOUNDS_LISTED);
        if (rows.length === 0) return { wounds: [] };
        const observationRows = await tx
          .select()
          .from(O)
          .where(
            and(
              eq(O.organizationId, organizationId),
              eq(O.status, "active"),
              inArray(
                O.woundId,
                rows.map((r) => r.id),
              ),
            ),
          )
          .orderBy(desc(O.observedAt), desc(O.id))
          .limit(MAX_LIST_OBSERVATIONS);
        const byWound = new Map<string, WoundObservationRecord[]>();
        for (const r of observationRows) {
          byWound.set(r.woundId, [...(byWound.get(r.woundId) ?? []), woundObservationRecordOf(r)]);
        }
        const wounds = rows.map((r): WoundListItem => {
          const wound = woundRecordOf(r);
          return {
            ...toWoundView(wound),
            latestObservation:
              toObservationDtos(byWound.get(wound.id) ?? [], { includeSuperseded: false })[0] ??
              null,
          };
        });
        return { wounds };
      });
    },

    async getWound(organizationId, patientId, woundId, opts) {
      return inOrg(organizationId, "", async (tx) => {
        const wound = await loadWound(tx, organizationId, patientId, woundId);
        return {
          wound: toWoundView(wound),
          observations: await currentObservationDtos(
            tx,
            organizationId,
            woundId,
            opts.includeSuperseded,
          ),
        };
      });
    },

    async createWound(actor, patientId, input): Promise<WoundView> {
      return inOrg(actor.organizationId, actor.userId, async (tx) => {
        assertValidWound(input, await todayForOrganization(tx, actor.organizationId));
        const [row] = await tx
          .insert(W)
          .values({
            organizationId: actor.organizationId,
            patientId,
            siteCode: input.siteCode,
            laterality: input.laterality,
            etiology: input.etiology,
            acquired: input.acquired ?? "unknown",
            onsetOn: input.onsetOn ?? null,
            createdByMembershipId: actor.membershipId,
          })
          .returning();
        if (!row) throw new Error("wound insert returned no row");
        return toWoundView(woundRecordOf(row));
      });
    },

    async recordObservation(actor, patientId, woundId, input) {
      const checkedVisit = input.sourceEncounterId ?? null;
      if (checkedVisit) await assertVisitOpen(actor, patientId, checkedVisit);
      const recorded = await inOrg(actor.organizationId, actor.userId, async (tx) => {
        const wound = await loadWound(tx, actor.organizationId, patientId, woundId, "share");
        assertWoundOpen(wound.status);
        assertValidWoundObservation(wound.etiology, input);
        const observedAt = input.observedAt ?? now().toISOString();
        assertValidObservedAt(observedAt, now(), wound.onsetOn);
        return insertObservation(
          tx,
          insertValuesOf(actor, wound, observedAt, input),
          actor.organizationId,
          wound.id,
        );
      });
      return untagIfVisitClosed(actor, patientId, recorded, checkedVisit);
    },

    async correctObservation(actor, patientId, woundId, observationId, ifVersion, input) {
      // Only a visit the observation is not already tied to is checked: a correction may keep its note even after the note is closed.
      let checkedVisit: string | null = null;
      if (input.sourceEncounterId) {
        const current = await taggedVisitOf(actor, patientId, woundId, observationId);
        if (input.sourceEncounterId !== current) {
          checkedVisit = input.sourceEncounterId;
          await assertVisitOpen(actor, patientId, checkedVisit);
        }
      }
      const corrected = await inOrg(actor.organizationId, actor.userId, async (tx) => {
        const wound = await loadWound(tx, actor.organizationId, patientId, woundId, "share");
        const [targetRow] = await tx
          .select()
          .from(O)
          .where(
            and(
              eq(O.organizationId, actor.organizationId),
              eq(O.woundId, wound.id),
              eq(O.id, observationId),
            ),
          )
          .limit(1)
          .for("update");
        if (!targetRow) throw new NotFoundError("wound observation");
        const target = woundObservationRecordOf(targetRow);
        assertCorrectable(target, ifVersion);
        assertValidWoundObservation(wound.etiology, input);
        const observedAt = input.observedAt ?? target.observedAt;
        assertValidObservedAt(observedAt, now(), wound.onsetOn);
        const values = insertValuesOf(
          actor,
          wound,
          observedAt,
          // Absent keeps the visit the observation was made at; an explicit null takes it out of the note.
          {
            ...input,
            sourceEncounterId:
              input.sourceEncounterId === undefined
                ? target.sourceEncounterId
                : input.sourceEncounterId,
          },
          { targetId: target.id, reason: input.correctionReason },
        );
        // The AFTER INSERT trigger flips the target to `superseded` (version + 1); nothing here updates it.
        return insertObservation(tx, values, actor.organizationId, wound.id);
      });
      return untagIfVisitClosed(actor, patientId, corrected, checkedVisit);
    },

    async resolveWound(actor, patientId, woundId, input): Promise<WoundView> {
      return inOrg(actor.organizationId, actor.userId, async (tx) => {
        const wound = await loadWound(tx, actor.organizationId, patientId, woundId, "update");
        assertWoundOpen(wound.status);
        const today = await todayForOrganization(tx, actor.organizationId);
        const closedOn = input.closedOn ?? today;
        assertValidWoundResolution({ onsetOn: wound.onsetOn, closedOn }, today);
        const [row] = await tx
          .update(W)
          .set({ status: input.status, closedOn })
          .where(and(eq(W.organizationId, actor.organizationId), eq(W.id, wound.id)))
          .returning();
        if (!row) throw new NotFoundError("wound");
        return toWoundView(woundRecordOf(row));
      });
    },
  };
}
