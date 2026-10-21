// apps/backend/src/modules/07-care-plan/seams/addendum-sources.ts — M7's two contributions to the FY2027
// election statement addendum (42 CFR 418.24(c)(4)–(5)), owned here because `problem` is M7's table.
//
//   NonCoveredItemsReader   — the plan of care's ACTIVE `unrelated` problems: the conditions the hospice has
//                             determined unrelated to the terminal illness and related conditions.
//   AddendumDiagnosesReader — the ACTIVE `terminal` + `related` problems: the (c)(4) identification block.
//
// Org-explicit (the reader runs from M6's outbox consumer and route service, outside a request scope), keyed by
// ADMISSION (`care_plan.admission_id`). Part 2: a `sud_related` problem is NEVER pre-filled onto the addendum —
// the addendum is shared with non-hospice providers and Medicare contractors (418.24(c)(9)), and redisclosure of
// a 42 CFR Part 2 record needs consent this read cannot decide. A clinician can still add such a line by hand.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type {
  AddendumDiagnoses,
  AddendumDiagnosesReader,
  NonCoveredItemSnapshot,
  NonCoveredItemsReader,
} from "@chartwarden/types";
import { and, asc, eq, inArray } from "drizzle-orm";

const CP = schema.carePlans;
const PROB = schema.problems;

/** The default (c)(6) line explanation for a problem the plan of care marks unrelated; the clinician edits it. */
export const UNRELATED_PROBLEM_REASON =
  "The hospice team determined this condition is not related to your terminal illness or related conditions and is not needed for pain or symptom management, so the hospice does not cover its treatment.";

function label(description: string, icd10: string | null): string {
  const code = icd10?.trim();
  return code ? `${description} (${code})` : description;
}

async function activeProblems(
  db: DbClient,
  organizationId: string,
  admissionId: string,
  kinds: readonly ("terminal" | "related" | "unrelated")[],
) {
  return withOrgContext(db, { organizationId, userId: "" }, (tx) =>
    tx
      .select({
        id: PROB.id,
        description: PROB.description,
        icd10Code: PROB.icd10Code,
        kind: PROB.kind,
        updatedAt: PROB.updatedAt,
      })
      .from(PROB)
      .innerJoin(CP, eq(CP.id, PROB.carePlanId))
      .where(
        and(
          eq(PROB.organizationId, organizationId),
          eq(CP.organizationId, organizationId),
          eq(CP.admissionId, admissionId),
          eq(PROB.status, "active"),
          eq(PROB.sudRelated, false),
          inArray(PROB.kind, [...kinds]),
        ),
      )
      .orderBy(asc(PROB.createdAt), asc(PROB.id)),
  );
}

/** M7's {@link NonCoveredItemsReader}: active, non-Part-2 `unrelated` problems as `condition` lines. */
export function createUnrelatedProblemItemsReader(db: DbClient): NonCoveredItemsReader {
  return {
    async listForAdmission(orgId, admissionId): Promise<NonCoveredItemSnapshot[]> {
      const rows = await activeProblems(db, orgId, admissionId, ["unrelated"]);
      return rows.map((r) => ({
        source: "problem" as const,
        sourceId: r.id,
        category: "condition" as const,
        description: label(r.description, r.icd10Code),
        reason: UNRELATED_PROBLEM_REASON,
        determinedAt: r.updatedAt.toISOString(),
        // `problem` records the adding MEMBERSHIP, not a user; the user is not resolvable here.
        determinedByUserId: null,
      }));
    },
  };
}

/** M7's {@link AddendumDiagnosesReader}: active, non-Part-2 terminal and related problems. */
export function createAddendumDiagnosesReader(db: DbClient): AddendumDiagnosesReader {
  return {
    async diagnosesForAdmission(orgId, admissionId): Promise<AddendumDiagnoses> {
      const rows = await activeProblems(db, orgId, admissionId, ["terminal", "related"]);
      const line = (r: (typeof rows)[number]) => ({
        icd10Code: r.icd10Code?.trim() || null,
        description: r.description,
      });
      return {
        terminal: rows.filter((r) => r.kind === "terminal").map(line),
        related: rows.filter((r) => r.kind === "related").map(line),
      };
    },
  };
}
