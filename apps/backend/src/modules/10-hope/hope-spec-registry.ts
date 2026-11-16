import { type DbClient, schema } from "@chartwarden/db";
import { HopeStateError } from "@chartwarden/hope";
import { and, asc, eq, gte, isNull, lte, or } from "drizzle-orm";

export class HopeSpecRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HopeSpecRegistryError";
  }
}
/**
 * No spec version is in force on a target date. A `HopeStateError` (422 `M10_SPEC_NOT_IN_FORCE`), not a plain registry
 * error, so every caller that lets it surface (record a timepoint, open a draft, complete an SFV) answers a typed 4xx
 * instead of a generic 500. The message names no date: the target date of a patient's record stays out of the response
 * (`targetDate` stays on the error for the operator reading it in code). It says nothing about what was or was not
 * saved (a request that runs more than one transaction may have committed an earlier step). It tells a POST, PUT or PATCH
 * client to use a NEW Idempotency-Key once the spec is loaded (a 422 is not a retryable outcome, so the idempotency layer
 * replays it for 24 h on the same key); a GET carries no key, so the sentence says so and a plain retry is enough.
 */
export class HopeSpecNotFoundForTargetDateError extends HopeStateError {
  constructor(readonly targetDate: string) {
    super(
      "M10_SPEC_NOT_IN_FORCE",
      "No HOPE spec version is in force for this record's target date. An administrator needs to load the spec version that covers it. On POST, PUT and PATCH the idempotency layer replays this 422 for 24 h on the same Idempotency-Key, so after the spec is loaded use a NEW Idempotency-Key; a GET has no key.",
    );
    this.name = "HopeSpecNotFoundForTargetDateError";
  }
}
export class HopeSpecVersionOverlapError extends HopeSpecRegistryError {
  constructor(readonly targetDate: string) {
    super(`Overlapping HOPE spec versions are effective for ${targetDate}`);
    this.name = "HopeSpecVersionOverlapError";
  }
}
export class HopeSpecItemNotFoundError extends HopeSpecRegistryError {
  constructor(readonly itemCode: string) {
    super(`HOPE spec item ${itemCode} was not found in the frozen spec version`);
    this.name = "HopeSpecItemNotFoundError";
  }
}
export class HopeSpecItemValueNotAllowedError extends HopeSpecRegistryError {
  constructor(
    readonly itemCode: string,
    readonly valueCode: string,
  ) {
    super(`HOPE spec item ${itemCode} does not allow value ${valueCode}`);
    this.name = "HopeSpecItemValueNotAllowedError";
  }
}
export class HopeAssessmentSpecNotInitializedError extends HopeSpecRegistryError {
  constructor(readonly assessmentId: string) {
    super(`HOPE assessment ${assessmentId} has no frozen spec version / ISC`);
    this.name = "HopeAssessmentSpecNotInitializedError";
  }
}

/**
 * Run `resolve` and, when it fails because no spec version is in force, log ONE line for the operator before the error
 * goes on. The error is a 4xx, which the error handler logs at info with only its code: without this line a CMS spec
 * whose effective date nobody has loaded makes every record, workspace, review and sign fail with nothing at warn or
 * error level naming the org or the record. `subject` names the record by id only (build it with `idForLog`), never by
 * target date or content. The HopeSpecVersionOverlapError sibling is a plain error, so it is already logged in full as a 500.
 */
export async function logSpecNotInForce<T>(subject: string, resolve: () => Promise<T>): Promise<T> {
  try {
    return await resolve();
  } catch (error) {
    if (error instanceof HopeSpecNotFoundForTargetDateError) {
      console.warn(
        `m10: M10_SPEC_NOT_IN_FORCE: no HOPE spec version is in force for the target date of ${subject}; an administrator needs to load the spec version that covers it.`,
      );
    }
    throw error;
  }
}

export type HopeIsc = "HA" | "HUV" | "HD" | "XX";

/** CMS uses caret for either a user-selectable blank or an applicability-owned skip. */
export function isCmsSkipBlankOption(
  options: readonly Pick<typeof schema.hopeSpecItemOptions.$inferSelect, "valueCode" | "label">[],
): boolean {
  return options.some((option) => option.valueCode === "^" && /skip\s*pattern/i.test(option.label));
}

export interface HopeSpecRegistry {
  requireVersion(versionId: string): Promise<typeof schema.hopeSpecVersions.$inferSelect>;
  resolveVersionForTargetDate(
    targetDate: Date | string,
  ): Promise<typeof schema.hopeSpecVersions.$inferSelect>;
  getItem(
    versionId: string,
    itemCode: string,
  ): Promise<typeof schema.hopeSpecItems.$inferSelect | null>;
  requireItem(
    versionId: string,
    itemCode: string,
  ): Promise<typeof schema.hopeSpecItems.$inferSelect>;
  getActiveItems(
    versionId: string,
    isc: HopeIsc,
  ): Promise<(typeof schema.hopeSpecItems.$inferSelect)[]>;
  getActiveItemsForAssessment(
    assessmentId: string,
  ): Promise<(typeof schema.hopeSpecItems.$inferSelect)[]>;
  getItemOptions(
    versionId: string,
    itemCode: string,
  ): Promise<(typeof schema.hopeSpecItemOptions.$inferSelect)[]>;
  requireAllowedValue(versionId: string, itemCode: string, valueCode: string): Promise<void>;
}

/**
 * The SQL condition "this spec version is in force on `date`" (`YYYY-MM-DD`): it started on or before the date and has
 * not ended before it. One definition for the registry's own lookup and for any caller that must pick a spec version by
 * the same rule (a future-dated or retired version is never in force).
 */
export function specVersionEffectiveOn(date: string) {
  const V = schema.hopeSpecVersions;
  return and(lte(V.effectiveFrom, date), or(isNull(V.effectiveTo), gte(V.effectiveTo, date)));
}

export function createHopeSpecRegistry(db: DbClient): HopeSpecRegistry {
  const V = schema.hopeSpecVersions;
  const I = schema.hopeSpecItems;
  const ISC = schema.hopeSpecItemIsc;
  const O = schema.hopeSpecItemOptions;
  const A = schema.hopeAssessments;

  return {
    async requireVersion(versionId) {
      const rows = await db.select().from(V).where(eq(V.id, versionId)).limit(1);
      const version = rows[0];
      if (!version) throw new HopeSpecRegistryError(`HOPE spec version ${versionId} was not found`);
      return version;
    },

    async resolveVersionForTargetDate(targetDate) {
      const date =
        typeof targetDate === "string"
          ? targetDate.slice(0, 10)
          : targetDate.toISOString().slice(0, 10);
      const rows = await db
        .select()
        .from(V)
        .where(specVersionEffectiveOn(date))
        .orderBy(asc(V.effectiveFrom));
      if (rows.length === 0) {
        throw new HopeSpecNotFoundForTargetDateError(date);
      }
      if (rows.length > 1) {
        throw new HopeSpecVersionOverlapError(date);
      }
      return rows[0]!;
    },

    async getItem(versionId, itemCode) {
      const rows = await db
        .select()
        .from(I)
        .where(and(eq(I.specVersionId, versionId), eq(I.itemCode, itemCode)))
        .limit(1);
      return rows[0] ?? null;
    },

    async requireItem(versionId, itemCode) {
      const item = await this.getItem(versionId, itemCode);
      if (!item) throw new HopeSpecItemNotFoundError(itemCode);
      return item;
    },

    async getActiveItems(versionId, isc) {
      const rows = await db
        .select({ item: I })
        .from(I)
        .innerJoin(ISC, eq(ISC.specItemId, I.id))
        .where(and(eq(I.specVersionId, versionId), eq(ISC.isc, isc), eq(ISC.active, true)))
        .orderBy(asc(I.sectionSortOrder), asc(I.itemSortOrder));
      return rows.map((row) => row.item);
    },

    async getActiveItemsForAssessment(assessmentId) {
      const [assessment] = await db
        .select({
          id: A.id,
          specVersionId: A.specVersionId,
          isc: A.isc,
        })
        .from(A)
        .where(eq(A.id, assessmentId))
        .limit(1);
      if (!assessment?.specVersionId || !assessment.isc) {
        throw new HopeAssessmentSpecNotInitializedError(assessmentId);
      }
      return this.getActiveItems(assessment.specVersionId, assessment.isc as HopeIsc);
    },

    async getItemOptions(versionId, itemCode) {
      const item = await this.getItem(versionId, itemCode);
      if (!item) return [];
      return db.select().from(O).where(eq(O.specItemId, item.id)).orderBy(asc(O.sortOrder));
    },

    async requireAllowedValue(versionId, itemCode, valueCode) {
      const item = await this.requireItem(versionId, itemCode);
      const rows = await db
        .select({ id: O.id })
        .from(O)
        .where(and(eq(O.specItemId, item.id), eq(O.valueCode, valueCode)))
        .limit(1);
      if (!rows[0]) throw new HopeSpecItemValueNotAllowedError(itemCode, valueCode);
    },
  };
}
