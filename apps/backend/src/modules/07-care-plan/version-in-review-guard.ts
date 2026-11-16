// apps/backend/src/modules/07-care-plan/version-in-review-guard.ts — Workflow 06 audit D-1.
//
// While a care-plan version is `in_review` its signers are signing the SEALED snapshot, so a live edit would
// leave the plan saying something nobody signed (and, for an IDG review, would strand its proposal as a
// conflict). Every write to the plan's working elements goes through this guard: return the version to draft
// first; the signatures are invalidated and the signers sign again.
//
// The plan row is locked FOR UPDATE before the version is read, the same order `finalizeVersion` and
// `signVersion` take (plan, then version): a concurrent finalize waits for this write to finish, and this
// write waits for a finalize, so an element write can never commit after the snapshot was sealed.
import { type DbClient, schema } from "@chartwarden/db";
import { and, eq } from "drizzle-orm";
import { CarePlanStateError } from "./lifecycle/errors";

const CP = schema.carePlans;
const CPV = schema.carePlanVersions;

export async function ensureNoVersionInReview(tx: DbClient, planId: string): Promise<void> {
  await tx.select({ id: CP.id }).from(CP).where(eq(CP.id, planId)).for("update");
  const [row] = await tx
    .select({ id: CPV.id })
    .from(CPV)
    .where(and(eq(CPV.carePlanId, planId), eq(CPV.status, "in_review")))
    .limit(1);
  if (row) {
    throw new CarePlanStateError(
      "VERSION_IN_REVIEW",
      "a version is in review: return it to draft before editing the plan",
    );
  }
}
