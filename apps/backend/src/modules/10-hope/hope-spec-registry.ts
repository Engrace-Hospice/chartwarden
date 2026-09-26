import { type DbClient, schema } from "@wardenx/db";
import { and, asc, eq, gte, isNull, lte, or } from "drizzle-orm";

export class HopeSpecRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HopeSpecRegistryError";
  }
}
export class HopeSpecNotFoundForTargetDateError extends HopeSpecRegistryError {
  constructor(readonly targetDate: string) {
    super(`No HOPE spec version is effective for ${targetDate}`);
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

export type HopeIsc = "HA" | "HUV" | "HD" | "XX";

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
        .where(and(lte(V.effectiveFrom, date), or(isNull(V.effectiveTo), gte(V.effectiveTo, date))))
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
