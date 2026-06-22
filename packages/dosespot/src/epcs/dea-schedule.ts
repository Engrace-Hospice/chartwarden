// @wardenx/dosespot — DEA schedule-authorization check (§2.4 §1311.120 / §4.7, M12-T05). Pure, IO-free.
//
// 21 CFR §1311.120 — logical access controls. EPCS controlled-substance signing is gated by both RBAC (the
// `prescribing.sign_controlled_substance` permission key) and the ABAC `dea_schedule_authorized[:schedule]`
// predicate, which consults the prescriber's `dosespot_prescriber.dea_authorized_schedules` array. A
// prescriber authorized for II/III but not IV/V cannot sign a Schedule IV order even with the role. This
// module owns the pure membership check the M12-T08 ABAC predicate (`dea_schedule_authorized`) and the EPCS
// sign route both compose; the prescriber's authorized-schedule array is injected as data (resolved upstream
// from MDM / the `dosespot_prescriber` row) — `@wardenx/types` + the sibling errors only.
import type { DeaSchedule } from "@wardenx/types";
import { requireEpcs } from "./errors";

/**
 * §1311.120 — is `schedule` a member of the prescriber's authorized DEA schedules? The authoritative
 * membership test the `dea_schedule_authorized` ABAC predicate (M12-T08) delegates to. A `null` schedule
 * (non-controlled order) is not an EPCS case and is never asked here.
 */
export function isDeaScheduleAuthorized(
  authorizedSchedules: readonly DeaSchedule[],
  schedule: DeaSchedule,
): boolean {
  return authorizedSchedules.includes(schedule);
}

/**
 * §1311.120 — assert the prescriber is authorized for this DEA schedule, throwing
 * `DEA_SCHEDULE_NOT_AUTHORIZED` otherwise. The EPCS sign route (M12-T08) calls this before issuing the 2FA
 * nonce; the medication-order machine repeats the guard inline as defence in depth.
 */
export function assertDeaScheduleAuthorized(
  authorizedSchedules: readonly DeaSchedule[],
  schedule: DeaSchedule,
): void {
  requireEpcs(
    isDeaScheduleAuthorized(authorizedSchedules, schedule),
    "DEA_SCHEDULE_NOT_AUTHORIZED",
    `the prescriber is not authorized for DEA Schedule ${schedule} (authorized: [${authorizedSchedules.join(", ")}])`,
  );
}
