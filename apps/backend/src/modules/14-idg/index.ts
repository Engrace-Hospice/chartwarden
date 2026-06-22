// apps/backend/src/modules/14-idg — M14 (Interdisciplinary Group / IDG) backend module surface.
//
// M14-T05 lands the three §4.8 owned seams (IdgPacketProvider — the packet-snapshot + M22 render handshake
// M22/M33 consume — + IdgDecisionProvider — the decision read path M30/M33 consume — + IdgScheduleProvider —
// the meeting-schedule + 15-day-cadence read path M28/M30/M33 consume) registered into the M1 registry via
// `registerIdgSeams` (driven from the composition root's wireModuleSeams()); the three §4.7 ABAC predicates M14
// owns (`quorate_decision` / `idg_meeting_scope` / `per_patient_review_floor_clear`); and the §4.1 route
// inventory behind the real `requirePermission` / `requireAbac` Authorization Contract (the §4.6 keys live in
// @wardenx/auth as `M14_CONTRIBUTED_PERMISSIONS`).
export {
  type IdgCadenceAdherence,
  type IdgDecisionSeedRow,
  type IdgSeamDeps,
  type IdgSeamSeed,
  type IdgSeamStore,
  type StoredIdgPacket,
  createIdgDecisionProvider,
  createIdgPacketProvider,
  createIdgScheduleProvider,
  createInMemoryIdgSeamStore,
  getIdgDecisionProvider,
  getIdgPacketProvider,
  getIdgScheduleProvider,
  registerIdgSeams,
} from "./seams/index";
// M14-T05 — the three §4.7 ABAC predicates M14 owns (`quorate_decision` / `idg_meeting_scope` /
// `per_patient_review_floor_clear`). The §4.6 permission keys M14 contributes to M3 live in @wardenx/auth
// (M14_CONTRIBUTED_PERMISSIONS).
export {
  type IdgAbacDeps,
  type IdgAbacResolver,
  type MeetingScopeFacts,
  type ReviewFloorBreachFact,
  M14_ABAC_PREDICATES,
  buildIdgAbacPredicates,
  registerIdgAbacPredicates,
} from "./abac-predicates";
// M14-T05 — the §4.1 route inventory over an in-memory backend + the route service contract (in-mem slice;
// Drizzle in prod under withOrgContext so RLS backstops).
export { type IdgRouteDeps, registerIdgRoutes } from "./routes/idg-routes";
export {
  type IdgRouteService,
  type IdgRouteSeed,
  type MeetingView,
  type AttendanceView,
  type AgendaItemView,
  type DecisionView,
  type ActionItemView,
  type MinutesView,
  type PacketDigestView,
  type RecurringPolicyView,
  type MeetingScheduleView,
  type RecordedIdgEvent,
  createInMemoryIdgBackend,
} from "./routes/service";
// M14-T06 — the §4.4 outbox contract (the full `m14.*` taxonomy + the canonical `idg.decision_recorded`
// cross-module decision seam; check-fitness-gaps.ts scans events-by-m14.ts for naming + ownership + declared
// consumers). **`idg.decision_recorded` wires LIVE the M7/M11/M12 decision consumers declared inert in Waves
// C–E.**
export { M14_OUTBOX_EVENTS } from "./events-by-m14";
// M14-T06 — the §4.5 outbox subscriptions: the M6 inclusion cache, the M7/M8/M11/M12 D8 action-item
// auto-close, the M9/M10/M11/M12 "since last IDG" projection cache, and the M22 PDF back-ref. Pure
// auto-close planner + the event → consumer binding registry; consumed event names are string literals
// (no dependsOn edge).
export {
  M14_AUTO_CLOSE_LINKED_KIND,
  M14_OUTBOX_SUBSCRIPTIONS,
  planActionItemAutoClose,
} from "./consumers/index";
// M14-T06 — the §4.10 M36 typed alert payloads M14 OWNS (packet-ready / action-item assigned + carry-forward
// compliance / non-quorate decision / per-patient review-clock + review-floor override). Registered onto
// M36's Foundation alert-payload registry at boot; composition + recipient resolution is M36's (ADR-0024).
export { M14_ALERT_PAYLOADS } from "./alerts-by-m14";
