// apps/backend/src/modules/27-cost-report/routes/cap-context-wiring.ts — binds the M27 cap-context resolver
// to the live M1 SeamRegistry. Kept separate from the pure `cap-context.ts` so unit tests exercise
// `resolveCapContext` with a stub seam (no bootstrap import). The eventual ValidationContextBuilder calls
// `resolveCapContext(m27CapSeamResolver, orgId, capYear)`; until then this is the wired-but-latent consumer.
import { getSeam } from "../../../bootstrap/index";
import type { CapAggregateSeam, CapSeamResolver } from "./cap-context";

/** The production resolver: M26's `CapAccrualReader` from the M1 registry (deny-stub until M26 db-binds). */
export const m27CapSeamResolver: CapSeamResolver = () =>
  getSeam("CapAccrualReader") as CapAggregateSeam;
