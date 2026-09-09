import { type DbClient, schema } from "@wardenx/db";
import { and, eq } from "drizzle-orm";
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
    readonly assessment: AssessmentRow;
    readonly isc: HopeIsc;
    readonly answers: CanonicalAnswerMap;
    readonly now?: Date;
  }): Promise<HopeSfvReconciliationResult>;
}

export function createHopeSfvService(): HopeSfvService {
  const SFV = schema.symptomFollowUpVisits;

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
          await tx
            .update(SFV)
            .set({ status: "withdrawn", updatedAt: now })
            .where(eq(SFV.id, existing.id));
          return { trigger, sfvId: existing.id, action: "withdrawn" };
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
        await tx
          .update(SFV)
          .set({ status: "open", dueAt, updatedAt: now })
          .where(eq(SFV.id, existing.id));
        return { trigger, sfvId: existing.id, action: "reopened" };
      }
      if (existing.dueAt.getTime() !== dueAt.getTime()) {
        await tx.update(SFV).set({ dueAt, updatedAt: now }).where(eq(SFV.id, existing.id));
        return { trigger, sfvId: existing.id, action: "updated_due_at" };
      }
      return { trigger, sfvId: existing.id, action: "none" };
    },
  };
}
