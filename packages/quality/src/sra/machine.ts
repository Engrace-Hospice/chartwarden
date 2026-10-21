// @wardenx/quality — §2.2 SRA (Security Risk Assessment) cycle lifecycle state machine (M30-P2a). Pure,
// IO-free.
//
// The `sra_cycle` aggregate lifecycle (§2.2):
//
//   chartered ─startAssessment→ in_progress ─submitForReview→ review ─close→ closed
//                                   ↑──────returnToProgress──────┘        │
//   closed ─reopen→ reopened ─resumeAfterReopen→ in_progress              │
//
// `close` (review → closed) requires the two-person co-sign per D12 / V-12 (Security Officer +
// Compliance Officer, DISTINCT individuals) AND a recent step-up auth (W-M30-30 — closing a survey-
// significant artifact demands a fresh re-auth). `reopen` (closed → reopened) requires the Compliance
// Officer's override, a reason ≥ 100 chars, and a recent step-up, and emits a `severity=critical` audit.
//
// W-M30-30 modelling: `recentStepUp` is a GUARD INPUT FLAG asserted by this reducer — the ACTUAL
// `Date.now() - lastStepUpAt > 300_000` check is enforced at the backend route (a later phase), which
// throws `StepUpRequiredError` before it ever calls the reducer; the flag here keeps the pure domain's
// invariant explicit and unit-testable. {@link SRA_STEP_UP_GATED_EVENTS} is the discoverable marker of
// which transitions are step-up gated.
//
// Mirrors the M11 order-machine convention: a transition is a PURE function `(state, event) -> next
// state` that validates the §2.2 graph then runs the enumerated guards (a guard failure throws a
// `ChartWardenError` with the precise code). No IO; every fact a guard needs is injected on the event.
import { ChartWardenError } from "@wardenx/types";
import type { SraCycleStatus } from "../contracts";

/** §2.2 — `reopen` requires a reason of at least this many characters. */
export const SRA_REOPEN_REASON_MIN_CHARS = 100;

/**
 * The transitions that require a recent step-up auth (W-M30-30). The marker is exported so the backend
 * route layer can assert the freshness check is wired for exactly these events; the reducer asserts the
 * injected `recentStepUp` flag on each.
 */
export const SRA_STEP_UP_GATED_EVENTS = ["close", "reopen"] as const;

/**
 * The two-person closure co-sign facts checked by {@link assertSraClosureCosign} (D12 / V-12). The two
 * cosigners are distinct roles (Security Officer + Compliance Officer) and must be distinct individuals.
 */
export interface SraClosureCosign {
  /** The Security Officer co-signer's M2 membership id. */
  readonly securityOfficerMembershipId: string;
  /** The Compliance Officer co-signer's M2 membership id. */
  readonly complianceOfficerMembershipId: string;
}

/** The §2.2 SRA-cycle lifecycle events. Per-event facts are resolved upstream and injected as data. */
export type SraCycleEvent =
  | {
      readonly type: "startAssessment";
    }
  | {
      readonly type: "submitForReview";
    }
  | {
      readonly type: "returnToProgress";
    }
  | {
      readonly type: "close";
      /** §2.2 / V-12 — the two-person closure co-sign (validated by {@link assertSraClosureCosign}). */
      readonly cosign: SraClosureCosign;
      /** W-M30-30 — the closing flow's step-up is recent (route-enforced; asserted here for the domain). */
      readonly recentStepUp: boolean;
    }
  | {
      readonly type: "reopen";
      /** §2.2 — the reopen reason (≥ {@link SRA_REOPEN_REASON_MIN_CHARS} chars; emits a `critical` audit). */
      readonly reason: string;
      /** §2.2 — the acting principal holds the Compliance Officer override authority. */
      readonly actorIsComplianceOfficer: boolean;
      /** W-M30-30 — the reopen flow's step-up is recent (route-enforced; asserted here for the domain). */
      readonly recentStepUp: boolean;
    }
  | {
      readonly type: "resumeAfterReopen";
    };

/** The legal §2.2 transition graph (from → events accepted). Guards are checked separately. */
export const SRA_CYCLE_GRAPH: Readonly<
  Record<SraCycleStatus, ReadonlyArray<SraCycleEvent["type"]>>
> = {
  chartered: ["startAssessment"],
  in_progress: ["submitForReview"],
  review: ["close", "returnToProgress"],
  closed: ["reopen"],
  reopened: ["resumeAfterReopen"],
};

/**
 * V-12 — the SRA-cycle-closure two-person co-sign guard (D12 / M30-F03 / ADR-0022). Throws a
 * {@link ChartWardenError} if the closure co-sign is not split across two distinct people. Pure; the actual
 * role checks (Security Officer vs Compliance Officer) are enforced at the backend route — here we
 * enforce the SPLIT-ACTOR invariant the schema CHECK can express only structurally.
 */
export function assertSraClosureCosign(cosign: SraClosureCosign): void {
  if (
    cosign.securityOfficerMembershipId.length === 0 ||
    cosign.complianceOfficerMembershipId.length === 0
  ) {
    throw new ChartWardenError(
      "SRA_CLOSE_COSIGN_INCOMPLETE",
      "closing an SRA cycle requires both a Security Officer and a Compliance Officer co-signer",
      422,
    );
  }
  if (cosign.securityOfficerMembershipId === cosign.complianceOfficerMembershipId) {
    throw new ChartWardenError(
      "SRA_CLOSE_REQUIRES_DISTINCT_COSIGNERS",
      "the SRA closure co-signers must be two distinct individuals (Security Officer + Compliance Officer)",
      422,
    );
  }
}

/**
 * Apply an `sra_cycle` lifecycle event (§2.2). Throws {@link ChartWardenError} `ILLEGAL_SRA_CYCLE_TRANSITION`
 * if the event is not accepted from `from`, or the specific §2.2 / W-M30-30 guard code on a guard
 * failure. Returns the next status; the route executes the persistence/audit/outbox around this pure core.
 */
export function transitionSraCycle(from: SraCycleStatus, event: SraCycleEvent): SraCycleStatus {
  if (!SRA_CYCLE_GRAPH[from].includes(event.type)) {
    throw new ChartWardenError(
      "ILLEGAL_SRA_CYCLE_TRANSITION",
      `sra_cycle cannot ${event.type} from '${from}'`,
      409,
    );
  }

  switch (event.type) {
    case "startAssessment":
      return "in_progress";

    case "submitForReview":
      return "review";

    case "returnToProgress":
      return "in_progress";

    case "close":
      assertSraClosureCosign(event.cosign);
      if (!event.recentStepUp) {
        throw new ChartWardenError(
          "SRA_CLOSE_REQUIRES_RECENT_STEP_UP",
          "closing an SRA cycle requires a recent step-up authentication",
          403,
        );
      }
      return "closed";

    case "reopen":
      if (!event.actorIsComplianceOfficer) {
        throw new ChartWardenError(
          "SRA_REOPEN_REQUIRES_COMPLIANCE_OFFICER",
          "reopening a closed SRA cycle requires the Compliance Officer override",
          403,
        );
      }
      if (event.reason.trim().length < SRA_REOPEN_REASON_MIN_CHARS) {
        throw new ChartWardenError(
          "SRA_REOPEN_REASON_TOO_SHORT",
          `reopening a closed SRA cycle requires a reason of at least ${SRA_REOPEN_REASON_MIN_CHARS} characters`,
          422,
        );
      }
      if (!event.recentStepUp) {
        throw new ChartWardenError(
          "SRA_REOPEN_REQUIRES_RECENT_STEP_UP",
          "reopening a closed SRA cycle requires a recent step-up authentication",
          403,
        );
      }
      return "reopened";

    case "resumeAfterReopen":
      return "in_progress";
  }
}
