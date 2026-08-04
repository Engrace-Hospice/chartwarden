// Planted violation (TASK-050D): a requireAbac() call naming a predicate NOTHING in this fixture
// tree declares (not M3_INTRINSIC_PREDICATES, not registerPredicate(...), not a *_PREDICATES
// array). The gate must fail closed on this the same way the real M30 inOrg incident did.
import { requireAbac } from "@wardenx/auth";

export const guard = requireAbac("fixture.read", "totally_unregistered_predicate");
