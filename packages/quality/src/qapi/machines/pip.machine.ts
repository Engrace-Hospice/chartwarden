import type { schema } from "@wardenx/db";
// @wardenx/quality — §2.2 QAPI PIP (Performance Improvement Project) lifecycle state machine (M30-P2a).
// Pure, IO-free.
//
// The `qapi_pip` aggregate lifecycle (§2.2):
//
//   chartering ─beginRca→ root_cause_analysis ─beginIntervention→ intervention_in_progress
//      └─beginMeasurement→ measurement ─conclude→ concluded
//   {any active phase} ─suspend→ suspended
//
// The `conclude` transition requires the two-person co-sign per D12 / V-11 (M30-F03 / ADR-0022): the
// QAPI Coordinator and the Medical Director, who must be DISTINCT individuals, and neither may be the
// person who chartered the PIP (closer ≠ charterer — separation of duties). `suspend` requires a reason
// ≥ 60 chars. Both `concluded` and `suspended` are terminal here; re-charter is a new PIP, mirroring the
// `completed | abandoned` shape of the sibling project machine (no resume edge in the §2.2 graph).
//
// Mirrors the M11 order-machine convention: a transition is a PURE function `(state, event) -> next
// state` that validates the §2.2 graph then runs the enumerated guards (a guard failure throws a
// `ChartWardenError` with the precise code). No IO; every fact a guard needs is injected on the event.
import { ChartWardenError } from "@wardenx/types";

/**
 * The PIP lifecycle phase — derived from the FROZEN `qapi_pip.status` pgEnum (no drift). The PIP phase
 * union is intentionally NOT in `contracts.ts` (only the project phase is published there); deriving it
 * from the row type keeps it locked to the schema.
 */
export type QapiPipPhase = schema.QapiPip["status"];

/** §2.2 — `suspended` requires a reason of at least this many characters. */
export const QAPI_PIP_SUSPEND_REASON_MIN_CHARS = 60;

/**
 * The two-person closure co-sign facts checked by {@link assertPipClosureCosign} (D12 / V-11). The two
 * cosigners are distinct roles (QAPI Coordinator + Medical Director); the guard additionally enforces
 * that neither cosigner is the PIP's charterer (closer ≠ charterer — separation of duties).
 */
export interface PipClosureCosign {
  /** The QAPI Coordinator co-signer's M2 membership id. */
  readonly qapiCoordinatorMembershipId: string;
  /** The Medical Director co-signer's M2 membership id. */
  readonly medicalDirectorMembershipId: string;
  /** The membership id of whoever chartered the PIP (the closer must differ from this — SoD). */
  readonly charteredByMembershipId: string;
}

/** The §2.2 QAPI-PIP lifecycle events. Per-event facts are resolved upstream and injected as data. */
export type QapiPipEvent =
  | {
      readonly type: "beginRca";
    }
  | {
      readonly type: "beginIntervention";
      /** §2.2 — the root-cause analysis is documented before the intervention starts. */
      readonly rootCauseDocumented: boolean;
    }
  | {
      readonly type: "beginMeasurement";
    }
  | {
      readonly type: "conclude";
      /** §2.2 — the documented conclusion narrative (must be non-empty). */
      readonly conclusionText: string;
      /** §2.2 / V-11 — the two-person closure co-sign (validated by {@link assertPipClosureCosign}). */
      readonly cosign: PipClosureCosign;
    }
  | {
      readonly type: "suspend";
      /** §2.2 — the suspension reason (≥ {@link QAPI_PIP_SUSPEND_REASON_MIN_CHARS} chars; emits a `warn` audit). */
      readonly reason: string;
    };

/** The legal §2.2 transition graph (from → events accepted). Guards are checked separately. */
export const QAPI_PIP_GRAPH: Readonly<Record<QapiPipPhase, ReadonlyArray<QapiPipEvent["type"]>>> = {
  chartering: ["beginRca", "suspend"],
  root_cause_analysis: ["beginIntervention", "suspend"],
  intervention_in_progress: ["beginMeasurement", "suspend"],
  measurement: ["conclude", "suspend"],
  concluded: [],
  suspended: [],
};

/**
 * V-11 — the PIP-closure two-person co-sign guard (D12 / M30-F03 / ADR-0022). Throws a {@link ChartWardenError}
 * if the closure co-sign is not split across two distinct people, or if either cosigner is the charterer.
 * Pure; the actual role checks (QAPI Coordinator vs Medical Director) are enforced at the backend route —
 * here we enforce the SPLIT-ACTOR invariant the schema CHECK can express only structurally.
 */
export function assertPipClosureCosign(cosign: PipClosureCosign): void {
  if (
    cosign.qapiCoordinatorMembershipId.length === 0 ||
    cosign.medicalDirectorMembershipId.length === 0
  ) {
    throw new ChartWardenError(
      "PIP_CLOSE_COSIGN_INCOMPLETE",
      "concluding a PIP requires both a QAPI Coordinator and a Medical Director co-signer",
      422,
    );
  }
  if (cosign.qapiCoordinatorMembershipId === cosign.medicalDirectorMembershipId) {
    throw new ChartWardenError(
      "PIP_CLOSE_REQUIRES_DISTINCT_COSIGNERS",
      "the PIP closure co-signers must be two distinct individuals (QAPI Coordinator + Medical Director)",
      422,
    );
  }
  if (
    cosign.charteredByMembershipId === cosign.qapiCoordinatorMembershipId ||
    cosign.charteredByMembershipId === cosign.medicalDirectorMembershipId
  ) {
    throw new ChartWardenError(
      "PIP_CLOSE_COSIGNER_IS_CHARTERER",
      "a PIP closure co-signer may not be the person who chartered the PIP (separation of duties)",
      422,
    );
  }
}

/**
 * Apply a `qapi_pip` lifecycle event (§2.2). Throws {@link ChartWardenError} `ILLEGAL_QAPI_PIP_TRANSITION` if
 * the event is not accepted from `from`, or the specific §2.2 guard code on a guard failure. Returns the
 * next phase; the route executes the persistence/audit/outbox around this pure core.
 */
export function transitionQapiPip(from: QapiPipPhase, event: QapiPipEvent): QapiPipPhase {
  if (!QAPI_PIP_GRAPH[from].includes(event.type)) {
    throw new ChartWardenError(
      "ILLEGAL_QAPI_PIP_TRANSITION",
      `qapi_pip cannot ${event.type} from '${from}'`,
      409,
    );
  }

  switch (event.type) {
    case "beginRca":
      return "root_cause_analysis";

    case "beginIntervention":
      if (!event.rootCauseDocumented) {
        throw new ChartWardenError(
          "QAPI_PIP_ROOT_CAUSE_REQUIRED",
          "the root-cause analysis must be documented before the intervention begins",
          422,
        );
      }
      return "intervention_in_progress";

    case "beginMeasurement":
      return "measurement";

    case "conclude":
      if (event.conclusionText.trim().length === 0) {
        throw new ChartWardenError(
          "QAPI_PIP_CONCLUSION_REQUIRED",
          "concluding a PIP requires a documented conclusion",
          422,
        );
      }
      assertPipClosureCosign(event.cosign);
      return "concluded";

    case "suspend":
      if (event.reason.trim().length < QAPI_PIP_SUSPEND_REASON_MIN_CHARS) {
        throw new ChartWardenError(
          "QAPI_PIP_SUSPEND_REASON_TOO_SHORT",
          `suspending a PIP requires a reason of at least ${QAPI_PIP_SUSPEND_REASON_MIN_CHARS} characters`,
          422,
        );
      }
      return "suspended";
  }
}
