// apps/backend/src/modules/03-authorization/seams.ts — M3's published read seam registration.
// Consumers (M33, M36) resolve `SupervisorReader` through getSeam() with no dependsOn edge on M3 (ADR-0005 D1).
// Without a db the registry's fail-closed deny-stub stands.
import type { DbClient } from "@wardenx/db";
import { registerSeam } from "../../bootstrap/index";
import { createSupervisorReader } from "./supervisor-reader";

export function registerAuthorizationSeams(deps: { db?: DbClient } = {}): void {
  if (deps.db) registerSeam("SupervisorReader", createSupervisorReader(deps.db));
}
