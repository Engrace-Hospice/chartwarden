// apps/backend/src/modules/17-scheduling/seams/oncall-rotation-store.ts — GAP-029: the Drizzle store over
// `oncall_rotation_entry`, M17's on-call rotation source. Backs BOTH the `tonightsOnCallRoster` read
// (request-scoped, like every other `VisitAssignmentReader` read) and M17's own rotation management routes
// (org-explicit, the `credentials-drizzle-store` shape).
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext, withOrgContextFromRequest } from "@wardenx/tenancy";
import { ConflictError, NotFoundError, ValidationError } from "@wardenx/types";
import type { OnCallRosterEntry } from "@wardenx/types";
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";

const ROT = schema.oncallRotationEntry;

/** M19's `oncall_shift_discipline` members M17 may name (`external` is M19's own administrative path). */
export const ONCALL_ROTATION_DISCIPLINES = [
  "clinical_rn",
  "clinical_lpn",
  "medical_director",
  "msw",
  "chaplain",
] as const;
export type OnCallRotationDiscipline = (typeof ONCALL_ROTATION_DISCIPLINES)[number];

/** The most roster rows one read returns — the roster is O(clinicians × upcoming nights). */
export const ONCALL_ROSTER_LIMIT = 1000;
const POSTGRES_UNIQUE_VIOLATION = "23505";

export interface OnCallRotationView {
  readonly id: string;
  readonly membershipId: string;
  readonly discipline: OnCallRotationDiscipline;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly cancelledAt: string | null;
}

export interface CreateOnCallRotationInput {
  readonly membershipId: string;
  readonly discipline: OnCallRotationDiscipline;
  readonly startsAt: string;
  readonly endsAt: string;
}

/**
 * The roster read's outcome. `none_configured` is NOT an empty roster: it means this tenant has never put a
 * rotation entry into M17, so M17 has no authority over its on-call shifts. M19's reconciler reads an empty
 * roster as "nobody is on call" and cancels every scheduled shift, so a tenant that schedules its shifts by
 * hand must read as unavailable (the §2.7 D-C branch), never as empty.
 */
export type OnCallRosterRead =
  | { readonly kind: "none_configured" }
  | { readonly kind: "roster"; readonly entries: ReadonlyArray<OnCallRosterEntry> };

export interface OnCallRotationStore {
  /** Request-scoped (the ambient org). Entries still running or upcoming as of `asOfIso`. */
  rosterAsOf(asOfIso: string): Promise<OnCallRosterRead>;
  list(
    organizationId: string,
    options?: { includeCancelled?: boolean },
  ): Promise<OnCallRotationView[]>;
  /** `actorMembershipId` is the acting membership (stamped on the row); the audit actor is the NULL system
   *  actor because a membership id is not a `user` id. */
  create(
    organizationId: string,
    actorMembershipId: string,
    input: CreateOnCallRotationInput,
  ): Promise<OnCallRotationView>;
  cancel(organizationId: string, actorMembershipId: string, entryId: string): Promise<void>;
}

type Row = typeof ROT.$inferSelect;

function toView(row: Row): OnCallRotationView {
  return {
    id: row.id,
    membershipId: row.membershipId,
    discipline: row.discipline as OnCallRotationDiscipline,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
  };
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } } | null)?.code;
  const causeCode = (error as { cause?: { code?: string } } | null)?.cause?.code;
  return code === POSTGRES_UNIQUE_VIOLATION || causeCode === POSTGRES_UNIQUE_VIOLATION;
}

export function createDrizzleOnCallRotationStore(db: DbClient): OnCallRotationStore {
  return {
    async rosterAsOf(asOfIso) {
      return withOrgContextFromRequest(db, async (tx): Promise<OnCallRosterRead> => {
        const [anyRow] = await tx.select({ id: ROT.id }).from(ROT).limit(1);
        if (!anyRow) return { kind: "none_configured" };
        const rows = await tx
          .select()
          .from(ROT)
          .where(and(isNull(ROT.cancelledAt), gt(ROT.endsAt, new Date(asOfIso))))
          .orderBy(asc(ROT.startsAt), asc(ROT.id))
          .limit(ONCALL_ROSTER_LIMIT);
        return {
          kind: "roster",
          entries: rows.map((r) => ({
            membershipId: r.membershipId as OnCallRosterEntry["membershipId"],
            discipline: r.discipline,
            fromIso: r.startsAt.toISOString() as OnCallRosterEntry["fromIso"],
            toIso: r.endsAt.toISOString() as OnCallRosterEntry["toIso"],
          })),
        };
      });
    },

    async list(organizationId, options = {}) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const rows = await tx
          .select()
          .from(ROT)
          .where(
            and(
              eq(ROT.organizationId, organizationId),
              options.includeCancelled ? undefined : isNull(ROT.cancelledAt),
            ),
          )
          .orderBy(asc(ROT.startsAt), asc(ROT.id))
          .limit(ONCALL_ROSTER_LIMIT);
        return rows.map(toView);
      });
    },

    async create(organizationId, actorMembershipId, input) {
      if (new Date(input.endsAt) <= new Date(input.startsAt)) {
        throw new ValidationError("endsAt must be after startsAt", [
          { field: "endsAt", code: "INVALID", message: "endsAt must be after startsAt" },
        ]);
      }
      try {
        return await withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
          const [member] = await tx
            .select({ id: schema.memberships.id })
            .from(schema.memberships)
            .where(
              and(
                eq(schema.memberships.id, input.membershipId),
                eq(schema.memberships.organizationId, organizationId),
              ),
            )
            .limit(1);
          if (!member) throw new NotFoundError("membership", input.membershipId);
          const [inserted] = await tx
            .insert(ROT)
            .values({
              organizationId,
              membershipId: input.membershipId,
              discipline: input.discipline,
              startsAt: new Date(input.startsAt),
              endsAt: new Date(input.endsAt),
              createdByMembershipId: actorMembershipId,
            })
            .returning();
          return toView(inserted as Row);
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictError("that rotation entry already exists");
        }
        throw error;
      }
    },

    async cancel(organizationId, actorMembershipId, entryId) {
      await withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const updated = await tx
          .update(ROT)
          .set({
            cancelledAt: sql`now()`,
            cancelledByMembershipId: actorMembershipId,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(ROT.organizationId, organizationId),
              eq(ROT.id, entryId),
              isNull(ROT.cancelledAt),
            ),
          )
          .returning({ id: ROT.id });
        if (updated.length === 0) throw new NotFoundError("on-call rotation entry", entryId);
      });
    },
  };
}
