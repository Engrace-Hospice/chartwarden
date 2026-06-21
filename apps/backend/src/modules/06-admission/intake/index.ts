// apps/backend/src/modules/06-admission/intake — M6-T07 referral & intake (§7.1) + admission wizard
// (§7.2) pure domain logic. The activation gate (R-AC-01) is the load-bearing pure rule; the referral
// triage/accept state guards and the `admission.draft_from_referral` bundle live in the in-memory
// backend (routes/service.ts) where they own the dataset, but enforce the same §7.1/§7.2 contract.
export {
  type ActivationGap,
  type ActivationFacts,
  type ActivationGate,
  computeActivationGate,
} from "./activation-gate";
