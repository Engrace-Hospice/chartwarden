// apps/backend/src/modules/19-oncall/seams/consumed.ts — the seams M19 CONSUMES (M19-T04).
//
// Architecture §25.15: M19 never imports M17's Drizzle schema. Every cross-module fact the §4.5 roster sync
// and the D10 inbound-trigger consumers need — tonight's on-call roster, and the tenancy + patient anchors
// behind a no-show or late-checkout visit — is resolved through the M1 boot-registered seam registry and
// handed to the pure deciders in `../consumers` / `../roster` as plain data.
//
// Resolving through `getSeam` is why M19's manifest `dependsOn` carries M1 (the registry lives in
// `apps/backend/src/bootstrap`, which is M1 code); M17 is already an M19 dependency per the manifest. The
// CONTRACT types are leaf `@wardenx/types` (ADR-0005 D1/D2) and the binding is runtime — the shape
// M15-T03 / M16-T03 / M21-T04 each use.
//
// The seams M19 PUBLISHES (§4.3 `OnCallProvider`, `TriageCallReader`, `TriageCallProvider`,
// `PortalTriageReader`, `TriageCallMetricsProvider`) land in M19-T06.
import type { VisitAssignmentReader, VisitReader } from "@wardenx/types";
import { getSeam } from "../../../bootstrap/index";

/**
 * M19 CONSUMES M17's §4.3 `VisitAssignmentReader` — specifically `tonightsOnCallRoster(orgId, asOfIso)`,
 * the Direct-model roster behind §4.5 path 1. Binding it here is what closes M17's Wave-F on-call-roster
 * deny-stub (Wave P2-2 acceptance #2).
 *
 * The read is DEGRADABLE, not load-bearing: §2.7's class D-C says an M17 timeout at shift-open falls back
 * to the last committed `on_call_shift` rows. `readOnCallRoster` below is where that translation happens,
 * so no caller ever sees a thrown seam error as an empty roster.
 */
export function getVisitAssignmentReader(): VisitAssignmentReader {
  return getSeam("VisitAssignmentReader");
}

/**
 * M19 CONSUMES M17's §4.3 `VisitReader` — the read-back behind both D10 inbound triggers.
 *
 * Neither trigger payload can anchor a `triage_call` on its own. `m17.visit.no_show_detected` carries
 * `{ visitId, patientId, clinicianMembershipId, scheduledStartedAt, reason }` and
 * `m18.evv.late_check_out_detected` carries `{ visitId, missingResolutionId, hoursPastGrace, hasCheckIn }`
 * — no `organization_id`, no `provider_entity_id`, and in M18's case no patient either. Every M19 PHI row
 * needs the first two NOT NULL. So the cascade is a read-back, not a projection of the event: an event name
 * is a TRIGGER, not a data feed (the M16-T03 / M21-T04 finding, and it holds twice over here because the
 * M18 payload is scoped to an EVV resolution row rather than to a patient).
 */
export function getVisitReader(): VisitReader {
  return getSeam("VisitReader");
}
