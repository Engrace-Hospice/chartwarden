import { type DbClient, schema } from "@chartwarden/db";
import { and, eq, inArray } from "drizzle-orm";
import type { HopeIsc } from "./hope-spec-registry";

type AssessmentRow = typeof schema.hopeAssessments.$inferSelect;

export const HOPE_J2051_ITEM_CODES = [
  "J2051A",
  "J2051B",
  "J2051C",
  "J2051D",
  "J2051E",
  "J2051F",
  "J2051G",
  "J2051H",
] as const;

type CanonicalAnswer = { readonly state: "answered" | "skipped"; readonly value: unknown | null };
type CanonicalAnswerMap = ReadonlyMap<string, CanonicalAnswer>;
type J2051Severity = "none" | "mild" | "moderate" | "severe";

export interface HopeJ2051TriggerState {
  readonly state: "true" | "false" | "pending";
  readonly triggerFired: boolean;
  readonly maxSeverity: J2051Severity;
  readonly symptomImpactDate: string | null;
}

const J2051_SEVERITY_RANK: Record<string, number> = { "0": 0, "1": 1, "2": 2, "3": 3, "9": 0 };
const J2051_SEVERITY_BY_RANK = ["none", "mild", "moderate", "severe"] as const;

export function canonicalAnsweredString(answer: CanonicalAnswer | undefined): string | null {
  if (answer?.state !== "answered") return null;
  if (typeof answer.value === "string") return answer.value;
  if (typeof answer.value === "number" && Number.isFinite(answer.value)) {
    return String(answer.value);
  }
  return null;
}

export function deriveHopeJ2051TriggerState(answers: CanonicalAnswerMap): HopeJ2051TriggerState {
  const symptomImpactPerformed = canonicalAnsweredString(answers.get("J2050A"));
  const symptomImpactDate = canonicalAnsweredString(answers.get("J2050B"));
  if (symptomImpactPerformed === "0") {
    return { state: "false", triggerFired: false, maxSeverity: "none", symptomImpactDate };
  }
  const values = HOPE_J2051_ITEM_CODES.map((itemCode) =>
    canonicalAnsweredString(answers.get(itemCode)),
  );
  const rank = Math.max(...values.map((value) => (value ? (J2051_SEVERITY_RANK[value] ?? 0) : 0)));
  const triggerFired = values.some((value) => value === "2" || value === "3");
  if (triggerFired) {
    return {
      state: "true",
      triggerFired: true,
      maxSeverity: J2051_SEVERITY_BY_RANK[rank] ?? "none",
      symptomImpactDate,
    };
  }
  const definitivelyFalse = values.every(
    (value) => value === "0" || value === "1" || value === "9",
  );
  return {
    state: definitivelyFalse ? "false" : "pending",
    triggerFired: false,
    maxSeverity: J2051_SEVERITY_BY_RANK[rank] ?? "none",
    symptomImpactDate,
  };
}

/**
 * The SFV `due_at` the live DB path writes: 23:59:59.999 UTC on the 2nd calendar day AFTER the
 * recorded J2050B answer (the clinician-entered "date of symptom impact screening", `YYYY-MM-DD`).
 *
 * - Anchor: the J2050B answer. Not `signed_at`, and not the assessment `target_date`. Signing time is
 *   never an input, so a late signature cannot extend the deadline: the invariant ADR-0018 D1 exists
 *   to protect holds (pinned in `__tests__/hope-sfv-service.test.ts`).
 * - Basis: UTC, not the organisation's local end of day. For a clinic west of UTC the deadline
 *   therefore falls earlier than its local end of day (about 7-8 hours for a Pacific clinic).
 *
 * OPEN COMPLIANCE QUESTION (CMS-VERIFY, undecided): ADR-0018 D1 anchors to the visit/assessment
 * date and names no timezone. The in-memory planner (`planSfvCreation`, packages/hope/src/sfv/sfv.ts)
 * anchors to that date and takes the end of it in the zone it is handed; there is no per-org timezone
 * seam, so HOPE scheduling falls back to DEFAULT_ORG_TIME_ZONE (America/Los_Angeles,
 * scheduling/schedule-writer.ts) and the in-memory backend to UTC unless seeded. Whether J2050B or the
 * visit date is authoritative, and UTC or an org-local end of day, must be settled against CMS
 * primary materials before this arithmetic changes. Until then it is deliberately unchanged
 * (docs/BUSINESS_LOGIC.md, M10 SFV bullet).
 */
export function hopeSfvDueAtFromJ2050B(symptomImpactDate: string): Date {
  const [year, month, day] = symptomImpactDate.split("-").map((part) => Number(part));
  if (!year || !month || !day) {
    throw new Error(`Invalid HOPE J2050B date: ${symptomImpactDate}`);
  }
  return new Date(Date.UTC(year, month - 1, day + 2, 23, 59, 59, 999));
}

export interface HopeSfvReconciliationResult {
  readonly trigger: HopeJ2051TriggerState;
  readonly sfvId: string | null;
  readonly action: "none" | "created" | "reopened" | "updated_due_at" | "withdrawn";
}

export interface HopeSfvService {
  reconcileTriggeringAssessment(input: {
    readonly tx: DbClient;
    readonly organizationId: string;
    /** What the reconciliation reads of the triggering assessment (a locked row's columns are enough). */
    readonly assessment: Pick<
      AssessmentRow,
      "id" | "rfaKind" | "providerEntityId" | "locationId" | "patientId" | "admissionId"
    >;
    readonly isc: HopeIsc;
    readonly answers: CanonicalAnswerMap;
    readonly now?: Date;
  }): Promise<HopeSfvReconciliationResult>;
}

export function createHopeSfvService(): HopeSfvService {
  const SFV = schema.symptomFollowUpVisits;
  type SfvRow = typeof SFV.$inferSelect;

  /** The statuses an operational edit (withdraw, move the due date) may start from; `completed`/`missed` never. */
  const OPERATIONAL_STATUSES: readonly SfvRow["status"][] = ["open", "overdue"];

  /**
   * Update `existing` ONLY while it is still in one of the statuses `from` this write may legitimately start from.
   * `reconcileTriggeringAssessment`'s only caller is `patchAnswers`, which takes the SFV row lock (`FOR UPDATE`)
   * before it reads this row, so a clinician's completion cannot interleave. The one writer that does NOT lock is
   * the cron watchdog, which flips `open` -> `overdue` from an unlocked snapshot; the status-family guard keeps a
   * legitimate withdraw / due-date change from losing to that benign flip (the SFV would stay overdue and could
   * decay to `missed`), while still never reverting `completed` or `missed`. Zero rows is a lost race, not an
   * error: the reconciliation reports no change (the next patch re-derives the state).
   */
  async function updateWhileIn(
    tx: DbClient,
    organizationId: string,
    existing: SfvRow,
    from: readonly SfvRow["status"][],
    patch: Partial<typeof SFV.$inferInsert>,
  ): Promise<boolean> {
    const rows = await tx
      .update(SFV)
      .set(patch)
      .where(
        and(
          eq(SFV.id, existing.id),
          eq(SFV.organizationId, organizationId),
          inArray(SFV.status, [...from]),
        ),
      )
      .returning({ id: SFV.id });
    return rows.length > 0;
  }

  return {
    async reconcileTriggeringAssessment({
      tx,
      organizationId,
      assessment,
      isc,
      answers,
      now = new Date(),
    }) {
      const trigger = deriveHopeJ2051TriggerState(answers);
      if (isc !== "HA" || assessment.rfaKind !== "01_admission") {
        return { trigger, sfvId: null, action: "none" };
      }
      const [existing] = await tx
        .select()
        .from(SFV)
        .where(
          and(
            eq(SFV.organizationId, organizationId),
            eq(SFV.triggeringAssessmentId, assessment.id),
          ),
        )
        .limit(1);
      const mutableOperationalStatus =
        existing?.status === "open" ||
        existing?.status === "overdue" ||
        existing?.status === "withdrawn";

      if (trigger.state !== "true" || !trigger.symptomImpactDate) {
        if (existing && mutableOperationalStatus && existing.status !== "withdrawn") {
          const won = await updateWhileIn(tx, organizationId, existing, OPERATIONAL_STATUSES, {
            status: "withdrawn",
            updatedAt: now,
          });
          return { trigger, sfvId: existing.id, action: won ? "withdrawn" : "none" };
        }
        return { trigger, sfvId: existing?.id ?? null, action: "none" };
      }

      const dueAt = hopeSfvDueAtFromJ2050B(trigger.symptomImpactDate);
      if (!existing) {
        const [created] = await tx
          .insert(SFV)
          .values({
            organizationId,
            providerEntityId: assessment.providerEntityId,
            locationId: assessment.locationId,
            patientId: assessment.patientId,
            admissionId: assessment.admissionId,
            triggeringAssessmentId: assessment.id,
            status: "open",
            triggeredAt: now,
            dueAt,
            alertCadence: {},
          })
          .returning({ id: SFV.id });
        return { trigger, sfvId: created?.id ?? null, action: "created" };
      }
      if (existing.status === "completed" || existing.status === "missed") {
        return { trigger, sfvId: existing.id, action: "none" };
      }
      if (existing.status === "withdrawn") {
        const won = await updateWhileIn(tx, organizationId, existing, ["withdrawn"], {
          status: "open",
          dueAt,
          updatedAt: now,
        });
        return { trigger, sfvId: existing.id, action: won ? "reopened" : "none" };
      }
      if (existing.dueAt.getTime() !== dueAt.getTime()) {
        const won = await updateWhileIn(tx, organizationId, existing, OPERATIONAL_STATUSES, {
          dueAt,
          updatedAt: now,
        });
        return { trigger, sfvId: existing.id, action: won ? "updated_due_at" : "none" };
      }
      return { trigger, sfvId: existing.id, action: "none" };
    },
  };
}
