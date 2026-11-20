// apps/backend/src/modules/08-encounters/findings/findings-drizzle.ts — WF09: the production FindingsService. Every read and write
// runs inside `withOrgContext`, so RLS scopes each row by `app.org_id` as the unprivileged `chartwarden_app` role (the explicit
// organization filter is the second lock). Like the rest of the M8 route service the context carries `userId: ""`, which
// inherits the ambient request actor so the write-audit trigger records WHO wrote, never a null actor.
//
// A PUT is stricter than the vitals writers, because the record is stated in the note and finalize pins the note: the encounter
// must be a DRAFT (signed, cosigned and void refuse with 409 IMMUTABLE_AFTER_SIGN, finalized with 409 NOTE_PINNED_AT_FINALIZE), and
// its template must have a section that states the record (422 FINDING_NOT_IN_NOTE); see ./findings-guards. The author's own first
// authoring write starts the visit-note closure clock (`stampDraftOpened`, ADR-0113) exactly as vitals do. An optional `If-Match`
// carries the `version` last read: a stale one is a 409 STALE_VERSION and writes nothing. A PUT whose body equals what is stored is a
// no-op (idempotent): it returns the stored record and its version unchanged, and writes nothing. No outbox event: the audit trigger
// is the trail.
//
// Concurrency: every PUT takes a row lock on its ENCOUNTER first (`no key update`, see ../encounter-row), and finalize takes the same
// lock before it reads the findings to pin the note. So a PUT and a finalize serialise either way (the PUT lands before the pin and the
// pinned note states it, or it waits and is refused 409), and two PUTs on one encounter serialise too, which is what makes a first
// write's `If-Match: 0` safe (the loser re-reads the committed record and gets 409 STALE_VERSION). The vitals and selections writes do
// NOT take the lock: they also race finalize, but they are allowed on a finalized note by design (no pin rewrite) and are left as they are.
import { type DbClient, schema } from "@chartwarden/db";
import { assertVersion } from "@chartwarden/shared/route-kit";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { stampDraftOpened } from "../closure/clock-stamp";
import { type EncounterRow, loadEncounterRow } from "../encounter-row";
import { type AdlColumns, planAdlRecord, recordedAdlFromRow } from "./adl";
import {
  type FindingKind,
  assertDraftForFinding,
  assertNoteStatesFinding,
} from "./findings-guards";
import {
  type FindingsService,
  type RecordedFindings,
  adlViewOf,
  nutritionViewOf,
  recordVersionOf,
  sameColumns,
} from "./findings-service";
import { type NutritionColumns, planNutritionRecord, recordedNutritionFromRow } from "./nutrition";
import { readWeightHistory, readWeightUnitMissing } from "./weight-history";

const ADL = schema.encounterAdlRecords;
const NUTRITION = schema.encounterNutritionRecords;

export interface FindingsServiceDeps {
  readonly db: DbClient;
  /** The instant stamped on `updated_at` and on a first-write clock; the server clock by default. */
  readonly clock?: () => Date;
}

/**
 * The `updated_at` an UPDATE writes: `now`, but never not-later-than the stored value, so the record's version (its `updated_at` in
 * ms, see `recordVersionOf`) moves on every write even when two land in the same millisecond or the clock steps back.
 */
const strictlyLater = (now: Date, stored: AnyPgColumn) =>
  sql`GREATEST(${now.toISOString()}::timestamptz, ${stored} + interval '1 millisecond')`;

const STALE_RECORD_MESSAGE =
  "the record changed since you read it; reload and try again (If-Match carries the version last read, 0 when none was recorded)";

const adlColumnsOf = (row: typeof ADL.$inferSelect): AdlColumns => ({
  bathing: row.bathing as AdlColumns["bathing"],
  dressing: row.dressing as AdlColumns["dressing"],
  grooming: row.grooming as AdlColumns["grooming"],
  toileting: row.toileting as AdlColumns["toileting"],
  transferring: row.transferring as AdlColumns["transferring"],
  ambulation: row.ambulation as AdlColumns["ambulation"],
  eating: row.eating as AdlColumns["eating"],
  bladder: row.bladder as AdlColumns["bladder"],
  bowel: row.bowel as AdlColumns["bowel"],
  devices: row.devices as AdlColumns["devices"],
});

// The text columns hold only what the CHECK constraints allow (the value sets of @chartwarden/hearthnote), so the casts above
// and below narrow `string` to a set the database already guarantees.
const nutritionColumnsOf = (row: typeof NUTRITION.$inferSelect): NutritionColumns => ({
  appetite: row.appetite as NutritionColumns["appetite"],
  mealIntakePercent: row.mealIntakePercent,
  fluidIntake: row.fluidIntake as NutritionColumns["fluidIntake"],
  swallowing: row.swallowing as NutritionColumns["swallowing"],
  support: row.support as NutritionColumns["support"],
});

/**
 * The ADL and nutrition records of one encounter, as the note's facts take them (a record with nothing recorded is absent). The
 * cheap read: two single-row selects, which is all the §2.6 gate needs to know which finding sections are populated.
 */
export async function loadRecordedRecords(
  tx: DbClient,
  args: { readonly organizationId: string; readonly encounterId: string },
): Promise<Pick<RecordedFindings, "adl" | "nutrition">> {
  const { organizationId, encounterId } = args;
  const [adlRow] = await tx
    .select()
    .from(ADL)
    .where(and(eq(ADL.encounterId, encounterId), eq(ADL.organizationId, organizationId)))
    .limit(1);
  const [nutritionRow] = await tx
    .select()
    .from(NUTRITION)
    .where(
      and(eq(NUTRITION.encounterId, encounterId), eq(NUTRITION.organizationId, organizationId)),
    )
    .limit(1);
  const adl = adlRow ? recordedAdlFromRow(adlColumnsOf(adlRow)) : undefined;
  const nutrition = nutritionRow
    ? recordedNutritionFromRow(nutritionColumnsOf(nutritionRow))
    : undefined;
  return {
    ...(adl && Object.keys(adl).length > 0 ? { adl } : {}),
    ...(nutrition && Object.keys(nutrition).length > 0 ? { nutrition } : {}),
  };
}

/**
 * Everything a visit note states from findings, read inside the note-facts transaction (the caller's tenant context): the ADL
 * record, the nutrition record and the patient's weight on an earlier signed visit. A finding with nothing recorded is absent
 * from the result. The previews and the assembly need all of it; the gate calls {@link loadRecordedRecords} alone.
 */
export async function loadRecordedFindings(
  tx: DbClient,
  args: { readonly organizationId: string; readonly encounterId: string },
): Promise<RecordedFindings> {
  const records = await loadRecordedRecords(tx, args);
  const { prior } = await readWeightHistory(tx, args, 1);
  return { ...records, ...(prior ? { priorWeight: prior } : {}) };
}

export function createDrizzleFindingsService(deps: FindingsServiceDeps): FindingsService {
  const { db } = deps;
  const clock = deps.clock ?? (() => new Date());

  const inTenant = <T>(organizationId: string, run: (t: DbClient) => Promise<T>): Promise<T> =>
    withOrgContext(db, { organizationId, userId: "" }, (tx) => run(tx as unknown as DbClient));

  /**
   * The encounter every write needs, row-locked (see the file header): visible, a draft whose template states the record, and the
   * author's clock stamped.
   */
  async function openForWrite(
    t: DbClient,
    organizationId: string,
    encounterId: string,
    actorMembershipId: string,
    kind: FindingKind,
  ): Promise<EncounterRow> {
    const encounter = await loadEncounterRow(t, encounterId, organizationId, "no key update");
    assertDraftForFinding(encounter.status);
    assertNoteStatesFinding(encounter.encounterType, encounter.discipline, kind);
    await stampDraftOpened(t, { organizationId, row: encounter, actorMembershipId, at: clock() });
    return encounter;
  }

  /**
   * One PUT, whichever record it replaces: lock and check the encounter, read the stored record, check the optional `If-Match` (409
   * unless it is the version the caller read), leave an unchanged record and its version alone (the idempotent no-op), else upsert.
   */
  async function writeRecord<Row extends { updatedAt: Date }, Cols extends object, View>(step: {
    readonly organizationId: string;
    readonly encounterId: string;
    readonly actorMembershipId: string;
    readonly kind: FindingKind;
    readonly ifMatch: number | undefined;
    readonly columns: Cols;
    readonly readStored: (t: DbClient) => Promise<Row | undefined>;
    readonly columnsOf: (row: Row) => Cols;
    readonly upsert: (t: DbClient, encounter: EncounterRow, now: Date) => Promise<Row | undefined>;
    readonly viewOf: (patientId: string, row: Row) => View;
  }): Promise<View> {
    return inTenant(step.organizationId, async (t) => {
      const { organizationId, encounterId, actorMembershipId, kind } = step;
      const encounter = await openForWrite(t, organizationId, encounterId, actorMembershipId, kind);
      const stored = await step.readStored(t);
      if (step.ifMatch !== undefined) {
        assertVersion(
          recordVersionOf(stored?.updatedAt ?? null),
          step.ifMatch,
          STALE_RECORD_MESSAGE,
        );
      }
      if (stored && sameColumns(step.columnsOf(stored), step.columns)) {
        return step.viewOf(encounter.patientId, stored);
      }
      const row = await step.upsert(t, encounter, clock());
      if (!row) throw new Error(`the ${kind} upsert returned no row`);
      return step.viewOf(encounter.patientId, row);
    });
  }

  const adlOf = (organizationId: string, encounterId: string) =>
    and(eq(ADL.encounterId, encounterId), eq(ADL.organizationId, organizationId));
  const nutritionOf = (organizationId: string, encounterId: string) =>
    and(eq(NUTRITION.encounterId, encounterId), eq(NUTRITION.organizationId, organizationId));

  return {
    async getAdl(organizationId, encounterId) {
      return inTenant(organizationId, async (t) => {
        const encounter = await loadEncounterRow(t, encounterId, organizationId);
        const [row] = await t.select().from(ADL).where(adlOf(organizationId, encounterId)).limit(1);
        return row
          ? adlViewOf(encounterId, encounter.patientId, adlColumnsOf(row), row.updatedAt)
          : null;
      });
    },

    async putAdl(organizationId, encounterId, input, actorMembershipId, ifMatch) {
      const columns = planAdlRecord(input);
      const values = { ...columns, devices: [...columns.devices] };
      return writeRecord({
        organizationId,
        encounterId,
        actorMembershipId,
        kind: "adl",
        ifMatch,
        columns,
        readStored: async (t) =>
          (await t.select().from(ADL).where(adlOf(organizationId, encounterId)).limit(1))[0],
        columnsOf: adlColumnsOf,
        upsert: async (t, encounter, now) =>
          (
            await t
              .insert(ADL)
              .values({
                organizationId,
                providerEntityId: encounter.providerEntityId,
                locationId: encounter.locationId,
                encounterId,
                ...values,
                createdByMembershipId: actorMembershipId,
                updatedByMembershipId: actorMembershipId,
                createdAt: now,
                updatedAt: now,
              })
              .onConflictDoUpdate({
                target: ADL.encounterId,
                set: {
                  ...values,
                  updatedByMembershipId: actorMembershipId,
                  updatedAt: strictlyLater(now, ADL.updatedAt),
                },
              })
              .returning()
          )[0],
        viewOf: (patientId, row) =>
          adlViewOf(encounterId, patientId, adlColumnsOf(row), row.updatedAt),
      });
    },

    async getNutrition(organizationId, encounterId) {
      return inTenant(organizationId, async (t) => {
        const encounter = await loadEncounterRow(t, encounterId, organizationId);
        const [row] = await t
          .select()
          .from(NUTRITION)
          .where(nutritionOf(organizationId, encounterId))
          .limit(1);
        return row
          ? nutritionViewOf(
              encounterId,
              encounter.patientId,
              nutritionColumnsOf(row),
              row.updatedAt,
            )
          : null;
      });
    },

    async putNutrition(organizationId, encounterId, input, actorMembershipId, ifMatch) {
      const columns = planNutritionRecord(input);
      return writeRecord({
        organizationId,
        encounterId,
        actorMembershipId,
        kind: "nutrition",
        ifMatch,
        columns,
        readStored: async (t) =>
          (
            await t
              .select()
              .from(NUTRITION)
              .where(nutritionOf(organizationId, encounterId))
              .limit(1)
          )[0],
        columnsOf: nutritionColumnsOf,
        upsert: async (t, encounter, now) =>
          (
            await t
              .insert(NUTRITION)
              .values({
                organizationId,
                providerEntityId: encounter.providerEntityId,
                locationId: encounter.locationId,
                encounterId,
                ...columns,
                createdByMembershipId: actorMembershipId,
                updatedByMembershipId: actorMembershipId,
                createdAt: now,
                updatedAt: now,
              })
              .onConflictDoUpdate({
                target: NUTRITION.encounterId,
                set: {
                  ...columns,
                  updatedByMembershipId: actorMembershipId,
                  updatedAt: strictlyLater(now, NUTRITION.updatedAt),
                },
              })
              .returning()
          )[0],
        viewOf: (patientId, row) =>
          nutritionViewOf(encounterId, patientId, nutritionColumnsOf(row), row.updatedAt),
      });
    },

    async getWeightHistory(organizationId, encounterId) {
      return inTenant(organizationId, async (t) => ({
        ...(await readWeightHistory(t, { organizationId, encounterId })),
        weightUnitMissing: await readWeightUnitMissing(t, { organizationId, encounterId }),
      }));
    },
  };
}
