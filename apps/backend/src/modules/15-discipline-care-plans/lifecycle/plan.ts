import { BOOTSTRAP_ON_ADMISSION_ACTIVATED } from "@wardenx/discipline-plans";
// apps/backend/src/modules/15-discipline-care-plans/lifecycle/plan.ts — M15-T03 (§2.2.1).
//
// The `discipline_care_plan` ROOT lifecycle: draft → active ⇄ draft_revising → discharged. One row per
// (admission_id, kind) — the partial unique index on the non-discharged rows is the structural backstop.
// `aide_poc | msw_plan | spiritual_plan` are bootstrapped in `draft` when M6's `admission.activated`
// outbox event is processed; `volunteer_plan` is created LAZILY on the first volunteer assignment (§1.1
// D10) because not every patient gets a volunteer and an empty volunteer plan on every admission is
// survey clutter. The root promotes to `active` when the first version reaches `signed`, re-opens as
// `draft_revising` when an IDG decision opens the next version (§7.7), and seals as `discharged` when M6
// emits `admission.discharged` (§7.11). Pure transitions over already-resolved facts; the per-version
// machine lives in `./version`, the supervisory clock in `./supervisory`.
import type { DisciplinePlanKind, IsoInstant } from "@wardenx/types";
import { type TransitionResult, result } from "./effects";
import { DisciplinePlanStateError } from "./errors";
import { computeNextSupervisoryDueAt } from "./supervisory";

/** The §2.2.1 plan-root states (mirrors `discipline_plan_status`). */
export type DisciplinePlanLifecycleState = "draft" | "active" | "draft_revising" | "discharged";

/** Why the plan sealed — the M6 admission-end cause that drove `m6.admission.discharged` (§7.11). */
export type DisciplinePlanDischargeReason = "discharge" | "death" | "revocation" | "transfer";

/** The §2.2.1 plan-root events. */
export type DisciplinePlanEvent =
  | {
      /** The plan's FIRST version reached `signed` (§2.2.2) — the root goes live. */
      readonly type: "activate";
      readonly at: IsoInstant;
      /** `aide_poc` arms the §418.76(h) clock at activation (§7.1); the other kinds carry no cadence. */
      readonly kind: DisciplinePlanKind;
      /** `COALESCE(supervisory_cadence_days_override, 14)` — validated by `./supervisory`. */
      readonly cadenceDays?: number;
    }
  | {
      /** An IDG decision (or an authoring discipline) opened the next version on a live plan (§7.7). */
      readonly type: "openNextVersion";
    }
  | {
      /** A subsequent version reached `signed` — the plan returns to `active` on the new snapshot. */
      readonly type: "versionSigned";
      readonly at: IsoInstant;
      readonly kind: DisciplinePlanKind;
      readonly cadenceDays?: number;
    }
  | {
      /** M6 `admission.discharged` — the auto-built discharge version is signed by the system actor. */
      readonly type: "discharge";
      readonly reason: DisciplinePlanDischargeReason;
      readonly at: IsoInstant;
    };

export type DisciplinePlanTransition = TransitionResult<
  DisciplinePlanLifecycleState,
  DisciplinePlanEvent["type"]
>;

/**
 * The legal §2.2.1 transition graph (from → events accepted). `draft → discharge` is legal on purpose:
 * §7.11 discharges EVERY one of the four plans, including a spiritual plan that never left `draft`
 * because the patient declined (§7.3) — a plan stuck in `draft` at discharge must still seal.
 */
export const DISCIPLINE_PLAN_GRAPH: Readonly<
  Record<DisciplinePlanLifecycleState, ReadonlyArray<DisciplinePlanEvent["type"]>>
> = {
  draft: ["activate", "discharge"],
  active: ["openNextVersion", "discharge"],
  draft_revising: ["versionSigned", "discharge"],
  discharged: [],
};

/** The result of bootstrapping a plan stub (§2.2.1 / §1.1 D10). */
export interface DisciplinePlanBootstrap {
  readonly status: "draft";
  readonly kind: DisciplinePlanKind;
  /** `initial_assessment_clock_started_at` — the anchor `./initial-clock` counts the D10 clock from. */
  readonly initialAssessmentClockStartedAt: IsoInstant;
  readonly effects: DisciplinePlanTransition["effects"];
}

/**
 * The `[*] → draft` factory (§2.2.1). Called by the `m6.admission.activated` consumer for the three
 * always-bootstrapped kinds and by the first volunteer assignment for `volunteer_plan`; emits
 * `m15.plan.bootstrapped` (idempotency key `planId`, §2.4) which M14's packet builder and M33 consume.
 * `anchoredAt` is the D10 clock anchor: the activation instant for the three, the assignment instant for
 * the volunteer plan.
 */
export function bootstrapDisciplinePlan(
  kind: DisciplinePlanKind,
  anchoredAt: IsoInstant,
): DisciplinePlanBootstrap {
  return {
    status: "draft",
    kind,
    initialAssessmentClockStartedAt: anchoredAt,
    effects: [
      { kind: "set_timestamp", field: "initial_assessment_clock_started_at", at: anchoredAt },
      { kind: "audit" },
      { kind: "outbox", event: "m15.plan.bootstrapped" },
    ],
  };
}

/** §1.1 / D10 — whether a kind is bootstrapped eagerly on `m6.admission.activated` (vs. lazily). */
export function isBootstrappedOnAdmissionActivated(kind: DisciplinePlanKind): boolean {
  return BOOTSTRAP_ON_ADMISSION_ACTIVATED.includes(kind);
}

/** The supervisory-clock effects a signed version produces — `aide_poc` only (§2.2.4 / §7.1). */
function supervisoryEffects(
  kind: DisciplinePlanKind,
  at: IsoInstant,
  cadenceDays: number | undefined,
): DisciplinePlanTransition["effects"] {
  if (kind !== "aide_poc") return [];
  return [
    {
      kind: "recompute_supervisory_due",
      nextDueAt: computeNextSupervisoryDueAt(at, cadenceDays ?? null),
    },
  ];
}

/** Apply a `discipline_care_plan` root event (§2.2.1). Throws `ILLEGAL_TRANSITION` if not accepted. */
export function transitionDisciplinePlan(
  from: DisciplinePlanLifecycleState,
  event: DisciplinePlanEvent,
): DisciplinePlanTransition {
  if (!DISCIPLINE_PLAN_GRAPH[from].includes(event.type)) {
    throw new DisciplinePlanStateError(
      "ILLEGAL_TRANSITION",
      `discipline plan cannot ${event.type} from '${from}'`,
    );
  }

  switch (event.type) {
    case "activate": {
      // §7.1 — on the CHHA acknowledgment that completes the Aide POC quorum the plan goes live and
      // `next_supervisory_due_at` arms at signature + cadence (14 days by default).
      return result(from, event.type, "active", [
        { kind: "flip_current_version" },
        ...supervisoryEffects(event.kind, event.at, event.cadenceDays),
        { kind: "audit" },
      ]);
    }
    case "openNextVersion": {
      // §7.7 — an IDG decision (or an authoring edit) opens draft v(n+1); the previously signed version
      // stays the current one until the new one signs, so the chart never has a gap.
      return result(from, event.type, "draft_revising", [{ kind: "audit" }]);
    }
    case "versionSigned": {
      return result(from, event.type, "active", [
        { kind: "flip_current_version" },
        ...supervisoryEffects(event.kind, event.at, event.cadenceDays),
        { kind: "audit" },
      ]);
    }
    case "discharge": {
      // §7.11 — the discharge version is auto-built and system-signed; any open draft is retained on the
      // record but no longer writable (`checkPlanWritable`, plus the audit trigger as the DB backstop).
      return result(from, event.type, "discharged", [
        { kind: "set_timestamp", field: "discharged_at", at: event.at },
        { kind: "audit" },
        { kind: "outbox", event: "m15.plan.discharged" },
      ]);
    }
  }
}
