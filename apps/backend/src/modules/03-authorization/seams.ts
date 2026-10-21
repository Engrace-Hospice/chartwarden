// apps/backend/src/modules/03-authorization/seams.ts — M3's published read seam registration.
// Consumers (M33, M36) resolve `SupervisorReader` through getSeam() with no dependsOn edge on M3 (ADR-0005 D1).
// Without a db the registry's fail-closed deny-stub stands.
import type { DbClient } from "@chartwarden/db";
import { registerSeam } from "../../bootstrap/index";
import { createDbAuditorEngagementReader } from "./engagement-reader";
import { createSupervisorReader } from "./supervisor-reader";

export function registerAuthorizationSeams(deps: { db?: DbClient } = {}): void {
  if (deps.db) {
    registerSeam("SupervisorReader", createSupervisorReader(deps.db));
    // GAP-093 — the auditor-engagement reader M31's `portal_engagement_scope` + auditor view consume.
    registerSeam("AuditorEngagementReader", createDbAuditorEngagementReader(deps.db));
  }
}
