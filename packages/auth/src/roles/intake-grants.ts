// The DEFAULT grants the two intake roles need to run the readmission / new-admission flow, wherever a tenant has
// created those roles. `intake_coordinator` and `intake_supervisor` exist only in the M6 spec §6 matrix (and in
// M6's unsited-admission ABAC roles); `ROLE_TEMPLATES` has no materializer, so nothing granted them these keys.
//
//   • `billing.eligibility.read` — the readmission screen's HETS benefit-period history
//     (`GET /api/v1/billing/eligibility/hospice-periods`, M23). READ ONLY: `billing.eligibility.check` (a live HETS
//     270/271 round-trip) is deliberately NOT granted — forcing a check stays a billing action.
//   • `admission.read` — the benefit-period plan reads (`GET /admissions/:id/readmission-context`,
//     `GET /patients/:patientId/benefit-period-plan`), M6's readmission decision aid.
//   • `admission.create` — `POST /api/v1/admissions`, the supervisor only: M6 spec §6.2 (normative for role-template
//     assignments) grants `admission.create` to `intake_supervisor` and not to `intake_coordinator`.
//
// NOT a `system_locked` floor: a tenant may remove a key from a role it owns. This is the single source the backfill
// migration `0374` and the dev-seed grant are pinned to — `m6-readmission.live.test.ts` compares migration and
// constant (the `LAB_RECOVERY_DEFAULT_GRANTS` / `0274` precedent).
export const INTAKE_DEFAULT_GRANTS = {
  intake_coordinator: ["admission.read", "billing.eligibility.read"],
  intake_supervisor: ["admission.create", "admission.read", "billing.eligibility.read"],
} as const satisfies Record<string, readonly string[]>;

/** The intake role keys (the M6 `admission_intake_scope` ABAC predicate keys off the same two). */
export const INTAKE_ROLE_KEYS = ["intake_coordinator", "intake_supervisor"] as const;
