// apps/backend/src/modules/11-orders/routes/service-actor-guards.ts — GAP-031 / GAP-030 (M11), SERVICE layer.
//
// The route layer already refuses a discipline the session does not hold (422) and an off-caseload patient (404).
// These guards repeat both checks inside the order service so they hold for EVERY caller — a worker, a seam
// consumer or a future route — not only the HTTP routes. The route-level checks stay: they give the early,
// uniform 404/422 before any service work.
//
// A caller that is NOT a human session says so with `SYSTEM_ORDER_ACTOR` (an explicit, frozen marker). A plain
// actor can never claim it by omission: the default (`EMPTY_ORDER_DETAIL_ACTOR`) holds no discipline and covers
// no patient, so it is refused.
import { NotFoundError } from "@chartwarden/types";
import { getSeam } from "../../../bootstrap/index";
import { assertDisciplineHeld } from "./server-derived-facts";

/**
 * The slice of the service actor these guards read (structurally satisfied by `ActorScopeFacts`; declared here so
 * this module does not import `./service`, which imports it).
 */
export interface ActorScopeFacts {
  readonly kind?: "user" | "system";
  readonly userId?: string;
  readonly orgWide?: boolean;
  readonly sessionPatientId?: string | null;
  readonly disciplines: readonly string[];
  readonly membershipId?: string;
  readonly roles?: readonly string[];
}

/** The patients on a clinician's caseload. `userId` is the M2 USER id (`patient_assignment.clinician_user_id`). */
export type OrderCaseloadResolver = (q: {
  organizationId: string;
  userId: string;
}) => Promise<readonly string[]>;

/** M5's published `CaseloadProvider` seam — the default resolver, looked up lazily (absent seam ⇒ fail closed). */
export const seamCaseloadResolver: OrderCaseloadResolver = (q) =>
  getSeam("CaseloadProvider").caseloadPatientIds(q);

/** True only for the explicit system marker (workers, outbox consumers, service-level suites). */
export const isSystemActor = (actor: ActorScopeFacts): boolean => actor.kind === "system";

/**
 * A caller-claimed discipline must be one the ACTOR really holds. A system actor is exempt: it acts for the
 * platform, not for a clinician, and carries no discipline of its own.
 */
export function assertActorHoldsDiscipline(actor: ActorScopeFacts, claimed: string): void {
  if (isSystemActor(actor)) return;
  assertDisciplineHeld(actor.disciplines, claimed);
}

/**
 * The actor must have the patient in scope: org-wide roles and system actors always do; everyone else needs the
 * patient on their caseload or pinned to their session. Out of scope ⇒ 404 (never reveal existence), and a
 * caseload that cannot be resolved fails CLOSED to the session-pinned patient only.
 */
export async function assertPatientInActorScope(
  actor: ActorScopeFacts,
  organizationId: string,
  patientId: string,
  resolveCaseload: OrderCaseloadResolver,
): Promise<void> {
  if (isSystemActor(actor) || actor.orgWide === true) return;
  if (actor.sessionPatientId && actor.sessionPatientId === patientId) return;
  if (actor.userId) {
    try {
      const caseload = await resolveCaseload({ organizationId, userId: actor.userId });
      if (caseload.includes(patientId)) return;
    } catch {
      // fail closed: an unresolvable caseload covers nobody
    }
  }
  throw new NotFoundError("order or patient not found");
}

const DRAFT_SUPERVISOR_ROLES: ReadonlySet<string> = new Set([
  "clinical_supervisor",
  "medical_director",
]);

/**
 * GAP-126 — only a draft's author or a supervisor (org-wide role / clinical supervisor / medical director) may
 * edit it. A non-human caller is exempt. Refused as a 404 so another clinician's draft is not disclosed.
 */
export function assertMayEditDraft(
  actor: ActorScopeFacts,
  order: { readonly id: string; readonly drafterMembershipId: string },
): void {
  if (actor.kind === "system") return;
  if (actor.membershipId !== undefined && order.drafterMembershipId === actor.membershipId) return;
  if (actor.orgWide === true || (actor.roles ?? []).some((r) => DRAFT_SUPERVISOR_ROLES.has(r)))
    return;
  throw new NotFoundError(`order ${order.id} is not a draft you may edit`);
}
