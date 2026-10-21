// apps/backend/src/modules/16-bereavement/lifecycle/validation.ts — M16-T03 (§2.5).
//
// The §2.5 validation-rule table, as standalone guards. The transitions in ./plan, ./contact and ./outreach
// enforce the rules that belong to a state change; these are the ones a route or worker must check on a
// path that does not move state — an ad-hoc touchpoint insert, a PATCH under `If-Match`, the D18
// first-contact gate — so they live here rather than being duplicated at each call site.
import {
  type BereavementExternalGateFacts,
  type BereavementExternalGateOverride,
  evaluateExternalSourceGate,
  isOutreachDueAtWithinCeiling,
} from "@chartwarden/bereavement";
import type {
  BereavementExternalSourceMetadata,
  BereavementOutreachKind,
  IsoInstant,
} from "@chartwarden/types";
import { BereavementStateError, require_ } from "./errors";

/**
 * §2.5 — `bereavement_plan.death_date` must equal the M6 admission's discharge-by-death date. Checked at
 * plan create against the fact resolved through M6's seams (../consumers/death-discharge.ts); a mismatch is
 * a 422 rather than a silent overwrite, because the death date anchors the ENTIRE 13-month clock and taking
 * the wrong one silently shortens or lengthens a survivor's program.
 */
export function checkDeathDateMatchesAdmission(
  planDeathDate: string,
  admissionDeathDate: string | null,
): void {
  require_(
    admissionDeathDate !== null,
    "DEATH_FACT_UNRESOLVED",
    "no death-discharge fact could be resolved for this admission",
  );
  require_(
    planDeathDate === admissionDeathDate,
    "BEREAVEMENT_DEATH_DATE_MISMATCH",
    `the plan death date ${planDeathDate} does not match the M6 discharge-by-death date ${admissionDeathDate}`,
  );
}

/** §2.5 — a proposed `due_at` must sit inside the window + 30-day grace the DB CHECK enforces. */
export function checkOutreachDueAt(deathDate: string, dueAtIso: IsoInstant): void {
  require_(
    isOutreachDueAtWithinCeiling(deathDate, dueAtIso),
    "OUTREACH_DUE_AT_OUT_OF_WINDOW",
    `${dueAtIso} is outside the 13-month bereavement window plus its 30-day grace`,
  );
}

/**
 * §2.5 — an AD-HOC touchpoint's kind must be one the survivor allows. This is stricter than the schedule
 * generator, which re-modalizes a floor contact rather than dropping it (see ./schedule): the generator is
 * discharging a regulatory minimum, while a counselor scheduling an extra call has no obligation to
 * override the family's stated wishes.
 */
export function checkOutreachKindAllowed(
  kind: BereavementOutreachKind,
  allowedKinds: ReadonlyArray<BereavementOutreachKind> | undefined,
): void {
  if (!allowedKinds || allowedKinds.length === 0) return;
  require_(
    allowedKinds.includes(kind),
    "OUTREACH_KIND_NOT_PERMITTED",
    `'${kind}' is not among this contact's permitted outreach kinds`,
  );
}

/**
 * §2.5 / §4.3.2 / D18 — the counselor first-contact gate for an external-source plan. The DECISION is pure
 * policy in `@chartwarden/bereavement`; this wrapper turns a denial into the §4.3.2 409 with the spec's exact
 * machine-readable code. An internal-clinician-recorded death (`externalSource === null`) is never gated.
 */
export function checkExternalSourceFirstContactGate(
  externalSource: BereavementExternalSourceMetadata | null,
  tenantOverride: BereavementExternalGateOverride | null,
  facts: BereavementExternalGateFacts,
): void {
  const decision = evaluateExternalSourceGate(externalSource, tenantOverride, facts);
  if (decision.allowed) return;
  throw new BereavementStateError(
    decision.code,
    "counselor first-contact is gated for this external-source bereavement plan",
  );
}

/** §2.5 — the `If-Match` optimistic-concurrency check on `bereavement_plan` / `bereaved_contact`. A
 *  mismatch answers 412 with the current row (the M7 §7.7 / M15 pattern verbatim). */
export function checkVersion(expected: number | undefined, actual: number): void {
  require_(
    expected === undefined || expected === actual,
    "STALE_VERSION",
    `the aggregate has moved on (If-Match ${expected}, current ${actual})`,
  );
}
