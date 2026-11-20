// The DEFAULT `discipline_plan.*` grants for the RN role keys and the aide's acknowledgment key (M15, the discipline care
// plans: Aide POC, MSW, spiritual and volunteer). Before this only the org-admin full catalog held them, so a tenant's nurse
// could neither open the Aide plan of care nor author, finalize or sign it, and an Aide POC could never collect its CHHA
// acknowledgment, until an administrator granted each key by hand (CW-AC-44 is the care plan twin).
//
//   • all five keys — `rn_case_manager` AND `rn`. RBAC only: WHICH patient is the care-team scope (`caseload_or_scope`, M15's
//     own `discipline_scope` check in the write service), so a grant widens no patient access.
//   • sign — the Aide POC quorum (packages/discipline-plans AIDE_POC_REQUIRED_SIGNERS) is the RN slot plus the CHHA
//     acknowledgment, and `signVersion` (GAP-045, `actorHoldsSignerRole`) accepts the RN slot of an Aide POC from either role key.
//     On the MSW and volunteer plans the same slot stays the RN case manager's, so `rn` holding the key cannot sign those.
//     Pinned by apps/backend/__tests__/discipline-plan-grants-pin.test.ts.
//   • sign only — `chha`, the aide's CoP 418.76 acknowledgment slot (`chha_acknowledgment`, never a cosignature). The aide
//     fills that slot and no other (`actorHoldsSignerRole`), still step-up and caseload gated. It gets NO read key: the read
//     keys are not scoped by plan kind, so they would show the aide every MSW, spiritual and volunteer plan of the patient.
//
// NOT granted: `discipline_plan.idg_revise` (the outbox consumer) and `discipline_plan.read_internal` (system principal).
// Clinical supervisor, DON and every other role are deliberately absent (a product decision: RNs first).
//
// NOT a `system_locked` floor: a tenant may remove a key from a role it owns.
//
// COVERAGE: existing tenants only — migration `1526` grants the keys to whichever of these roles each tenant already has. None of
// the roles is a ROLE_TEMPLATE, so a new tenant's materializer creates none (`discipline-plan-grants.test.ts` fails if one is
// promoted to a template without carrying its grants); a role created after migration 1526 receives nothing, as with the care
// plan, admitting-clinician and code-status grants.
// This is the single source migration `1526` is pinned to (`discipline-plan-grants.test.ts`).

const KEYS = [
  "discipline_plan.read",
  "discipline_plan.read_summary",
  "discipline_plan.author",
  "discipline_plan.finalize",
  "discipline_plan.sign",
] as const;

/** Role key → the `discipline_plan.*` keys it holds by default. */
export const DISCIPLINE_PLAN_DEFAULT_GRANTS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    rn: KEYS,
    rn_case_manager: KEYS,
    chha: ["discipline_plan.sign"],
  });

/** The role keys that hold at least one default `discipline_plan.*` grant. */
export const DISCIPLINE_PLAN_GRANTEE_ROLE_KEYS = Object.keys(DISCIPLINE_PLAN_DEFAULT_GRANTS);
