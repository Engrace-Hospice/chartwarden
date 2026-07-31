// @wardenx/auth · abac (M3 — Authorization). Owned per module-manifest.ts codePath
// `packages/auth/src/abac`. The Authorization Contract's ABAC surface — `requireAbac` /
// `requireStepUp` + the break-glass branch seams (M3-T05) — ships in ./require-abac; the
// named-predicate registry it consumes (the seam every later module registers into) ships
// in ./registry (M3-T07).
export {
  type AbacPredicate,
  type DeviceAttestation,
  type PredicateRegistry,
  DEVICE_ATTESTATION_ATTRIBUTE,
  M3_INTRINSIC_PREDICATES,
  abacRegistry,
  createPredicateRegistry,
  deviceAttestationValid,
  locationScope,
  providerEntityScope,
  registerAbacRegistry,
  registerPredicate,
  resetAbacRegistry,
} from "./registry";
export { isStepUpRecent } from "./step-up";
export {
  type AbacContext,
  type AbacEvaluator,
  type AbacTarget,
  type BreakGlassAccess,
  type BreakGlassAuditHook,
  type BreakGlassChecker,
  type BreakGlassGrant,
  type RequireAbacOptions,
  BREAK_GLASS_ATTRIBUTE,
  requireAbac,
  requireStepUp,
  resetAbacEvaluator,
  resetAuthorizationContract,
  resetBreakGlassAuditHook,
  resetBreakGlassChecker,
  setAbacEvaluator,
  setBreakGlassAuditHook,
  setBreakGlassChecker,
} from "./require-abac";
