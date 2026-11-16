// apps/backend/src/modules/07-care-plan/plan-selection.ts — the ONE rule for "which care plan is this
// patient's plan". `care_plan` has one row per ADMISSION (not per patient), so a patient who is
// discharged and re-admitted has two rows. The patient's plan is the newest non-discharged plan; when
// every plan is discharged, the newest one (so a discharged chart still reads). The route service's
// patient read, the §7.8 CarePlanReader store, the M15 active-problem read and the M14 packet-cover
// read all order by this expression so they never disagree about which row they mean.
import { schema } from "@chartwarden/db";
import { desc, sql } from "drizzle-orm";

const CP = schema.carePlans;

/** `ORDER BY` for a patient's candidate plans: non-discharged first, then newest `created_at` first. */
export const PATIENT_PLAN_ORDER = [sql`(${CP.status} = 'discharged')`, desc(CP.createdAt)] as const;
