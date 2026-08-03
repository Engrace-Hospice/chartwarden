// apps/backend/src/modules/08-encounters — Module 8 (Encounters & Visit Notes).
// M8-T04 lands the pure domain core (the §2.3 encounter + addendum state machines, the §2.7 validation
// catalog, the §2.8 in-transaction side-effect rules). Schema/RLS shipped in T02/T03 (types in
// @wardenx/types from T01); HearthNote Layer 1 (T05), cosignature workflow (T06), late-entry tiers
// (T07), seams (T08), routes (T09) all compose over this pure core.
import type { DbClient } from "@wardenx/db";
import type { FastifyInstance } from "fastify";
import {
  type EncounterWriteOutboxPort,
  createDbEncounterAbacResolver,
  createDbEncounterRouteService,
} from "./encounters-route-service-db";
import { registerEncounterAbacPredicates as _registerM8Abac } from "./abac-predicates";
import { registerEncounterRoutes as _registerM8Routes } from "./routes/encounters-routes";

/**
 * M8L-T01/T02 — mount the M8 encounter routes over the PRODUCTION Drizzle route service + ABAC resolver
 * (RLS-scoped under `withOrgContext`). Called from the composition root's db branch. Reads and the full
 * write lifecycle (draft → vitals/mileage → finalize → sign → cosign → addendum) are live over Drizzle;
 * every mutation emits its `m8.*` event on the passed transactional-outbox publisher (the composition
 * root binds M1's catalog-validating publisher pinned to caller-module `m8`). Replaces the in-memory
 * clinical-core scaffold mount for M8.
 */
export function mountEncounterRoutes(
  app: FastifyInstance,
  db: DbClient,
  outbox?: EncounterWriteOutboxPort,
): void {
  _registerM8Abac({ resolver: createDbEncounterAbacResolver(db) });
  _registerM8Routes(app, { service: createDbEncounterRouteService(db, outbox) });
}

export * from "./lifecycle/index";
// M8-T06 — the §2.4 D3 cosignature-request state machine + 12h/24h/48h SLA clock.
export * from "./cosignature/index";
// M8-T07 — the §2.5 D4 late-entry tier clock + significant/administrative override workflows.
export * from "./late-entry/index";
// M8-T10 — the §2.2 vitals/mileage authoring machines + the §7.4 D1 F2F dual-write coordination.
export * from "./authoring/index";
// M8-T08 — the §4.7 owned seams (Billable/Signed/Mileage/Creator) + the M7 CarePlanReader M8 consumes.
export * from "./seams/index";
// M8-T09 — the §4.1 route inventory (31 routes) behind the REAL Authorization Contract on the §4.5 keys
// M8 contributes to M3 (M8_CONTRIBUTED_PERMISSIONS in @wardenx/auth) + the §4.6 `m8.cosigner_role_match`
// ABAC predicate M8 registers into M3. In-memory route service + AbacResolver for boot-without-DB/tests.
export {
  type EncounterRouteDeps,
  registerEncounterRoutes,
} from "./routes/encounters-routes";
export {
  type EncounterWriteOutboxPort,
  createDbEncounterAbacResolver,
  createDbEncounterRouteService,
} from "./encounters-route-service-db";
export {
  type CreateEncounterArgs,
  type CreatedEncounter,
  type EncounterAbacFacts,
  type EncounterAbacResolver,
  type EncounterBackendInspect,
  type EncounterRouteSeed,
  type EncounterRouteService,
  type EncounterView,
  type MileageResult,
  type VitalsResult,
  createInMemoryEncounterBackend,
} from "./routes/service";
export {
  type EncounterAbacDeps,
  M8_ABAC_PREDICATES,
  buildEncounterAbacPredicates,
  registerEncounterAbacPredicates,
} from "./abac-predicates";
// M8-T11 — the §4.4 outbox contract (the full `m8.*` taxonomy; check-fitness-gaps.ts scans events-by-m8.ts
// for naming + ownership + declared consumers). `m8.encounter.signed` is the locked clinical-record trigger.
export { M8_OUTBOX_EVENTS } from "./events-by-m8";
// M8-T11 — the M17 visit-scheduling consumer (inert): the pure `decideVisitSeeding` decision core + the
// forward-declared (deferred) outbox binding M17 dispatches to once it lands (Wave F). No `dependsOn` edge.
export {
  type VisitSeedingAction,
  type VisitSeedingFacts,
  type VisitSeedingSkipReason,
  type VisitScheduledPayload,
  decideVisitSeeding,
} from "./consumers/seed-visit-encounter";
export {
  M8_VISIT_SCHEDULED_CONSUMER,
  M8_VISIT_SCHEDULED_CONSUMER_DEFERRED,
  decideVisitScheduled,
} from "./outbox-consumers/m17-visit-scheduled";
// M8-T12 — the `encounter_record` destruction-cert eraser (§3.6 / D9): crypto-erase the HearthNote
// ciphertext (tenant DEK), delete the encounter satellites, tombstone the `encounter` root (D8). The
// composition root calls registerEncounterErasers() over the Phase-0 deny-stub.
export {
  type EncounterEraseCounts,
  type EncounterEraseStore,
  type EncounterEraserDeps,
  createDrizzleEncounterEraseStore,
  createEncounterEraser,
  createInMemoryEncounterEraseStore,
  eraseEncounterRecord,
  registerEncounterErasers,
} from "./erasers/encounter-eraser";
