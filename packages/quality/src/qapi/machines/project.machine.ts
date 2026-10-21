// @wardenx/quality — §2.2 QAPI project lifecycle state machine (M30-P2a). Pure, IO-free.
//
// The `qapi_project` aggregate lifecycle (§2.2):
//
//   proposed ─activate→ active ─enterCorrectiveAction→ corrective_action ─complete→ completed
//      │                  │  └complete→ completed                          │
//      └abandon→ abandoned└abandon→ abandoned          abandon→ abandoned──┘
//
// `corrective_action` is the state that lands the project on the risk register (the root cause has been
// identified and the intervention is being implemented). `completed` requires a documented outcome that
// reaches or surpasses the target; `abandoned` requires a reason ≥ 60 chars.
//
// Mirrors the M11 order-machine convention: a transition is a PURE function `(state, event) -> next
// state` that first validates the event is legal from the current state (the §2.2 graph — nothing
// transitions on a string match), then runs the enumerated guards (a guard failure throws a
// `ChartWardenError` with the precise code). No IO; every fact a guard needs is resolved upstream and
// passed in on the event. The backend route (a later phase) executes the persistence + audit + outbox
// around this pure core.
import { ChartWardenError } from "@wardenx/types";
import type { QapiProjectPhase } from "../../contracts";

/** §2.2 — `abandoned` requires a reason of at least this many characters. */
export const QAPI_PROJECT_ABANDON_REASON_MIN_CHARS = 60;

/** The §2.2 QAPI-project lifecycle events. Per-event facts are resolved upstream and injected as data. */
export type QapiProjectEvent =
  | {
      readonly type: "activate";
    }
  | {
      readonly type: "enterCorrectiveAction";
      /** §2.2 — a root cause has been identified (the precondition for the risk-register-landing state). */
      readonly rootCauseIdentified: boolean;
    }
  | {
      readonly type: "complete";
      /** §2.2 — the documented outcome narrative (must be non-empty). */
      readonly outcomeText: string;
      /** §2.2 / V-10 — the documented outcome reaches or surpasses the project target. */
      readonly outcomeMeetsTarget: boolean;
    }
  | {
      readonly type: "abandon";
      /** §2.2 — the abandonment reason (≥ {@link QAPI_PROJECT_ABANDON_REASON_MIN_CHARS} chars). */
      readonly reason: string;
    };

/** The legal §2.2 transition graph (from → events accepted). Guards are checked separately. */
export const QAPI_PROJECT_GRAPH: Readonly<
  Record<QapiProjectPhase, ReadonlyArray<QapiProjectEvent["type"]>>
> = {
  proposed: ["activate", "abandon"],
  active: ["enterCorrectiveAction", "complete", "abandon"],
  corrective_action: ["complete", "abandon"],
  completed: [],
  abandoned: [],
};

/**
 * Apply a `qapi_project` lifecycle event (§2.2). Throws {@link ChartWardenError} `ILLEGAL_QAPI_PROJECT_TRANSITION`
 * if the event is not accepted from `from`, or the specific §2.2 guard code on a guard failure. Returns the
 * next phase; the route executes the persistence/audit/outbox around this pure core.
 */
export function transitionQapiProject(
  from: QapiProjectPhase,
  event: QapiProjectEvent,
): QapiProjectPhase {
  if (!QAPI_PROJECT_GRAPH[from].includes(event.type)) {
    throw new ChartWardenError(
      "ILLEGAL_QAPI_PROJECT_TRANSITION",
      `qapi_project cannot ${event.type} from '${from}'`,
      409,
    );
  }

  switch (event.type) {
    case "activate":
      return "active";

    case "enterCorrectiveAction":
      if (!event.rootCauseIdentified) {
        throw new ChartWardenError(
          "QAPI_PROJECT_ROOT_CAUSE_REQUIRED",
          "a root cause must be identified before a project enters corrective_action",
          422,
        );
      }
      return "corrective_action";

    case "complete":
      if (event.outcomeText.trim().length === 0) {
        throw new ChartWardenError(
          "QAPI_PROJECT_OUTCOME_REQUIRED",
          "completing a project requires a documented outcome",
          422,
        );
      }
      if (!event.outcomeMeetsTarget) {
        throw new ChartWardenError(
          "QAPI_PROJECT_OUTCOME_NOT_MET",
          "a project may only be completed when its documented outcome reaches or surpasses the target",
          422,
        );
      }
      return "completed";

    case "abandon":
      if (event.reason.trim().length < QAPI_PROJECT_ABANDON_REASON_MIN_CHARS) {
        throw new ChartWardenError(
          "QAPI_PROJECT_ABANDON_REASON_TOO_SHORT",
          `abandoning a project requires a reason of at least ${QAPI_PROJECT_ABANDON_REASON_MIN_CHARS} characters`,
          422,
        );
      }
      return "abandoned";
  }
}
