// apps/backend/src/modules/37-ipu — M37 Inpatient Unit (IPU) Management backend module entrypoint.
//
// The pure §2 domain kernels live in @wardenx/inpatient (T03–T10); this module is the HTTP/adapter surface.
// As of T11b it exposes the §4.7 ABAC predicate registration; the §4.1 routes + Drizzle route service +
// §4.4 outbox catalog + §7.7 eraser + SeamRegistry registration land across the remaining T11 slices.
export {
  M37_REGISTERED_ABAC_PREDICATES,
  type M37RegisteredAbacPredicate,
  buildM37AbacPredicates,
  registerM37AbacPredicates,
} from "./abac/predicates";

// §4.6 — the permission keys M37 contributes to M3 (declared in @wardenx/auth; re-exported for the route
// layer's requirePermission handlers).
export { M37_CONTRIBUTED_PERMISSIONS, type M37ContributedPermissionKey } from "@wardenx/auth";
