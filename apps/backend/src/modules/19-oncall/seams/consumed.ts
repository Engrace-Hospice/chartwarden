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
// `PortalTriageReader`, `TriageCallMetricsProvider`) land in `./index.ts` (M19-T06), alongside the two
// ADVISORY M32 seams added at the bottom of this file.
import type {
  EncounterCreator,
  HospitalizationRiskProvider,
  MedicationOrderProvider,
  OrderProvider,
  OrderSignatureProvider,
  ProtocolSuggestionProvider,
  RefillInboxProvider,
  VisitAssignmentReader,
  VisitReader,
} from "@wardenx/types";
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

/**
 * M19 CONSUMES M8's §4.7 `EncounterCreator` — D8's whole writeback path. M19 never writes an `encounter`
 * row; it asks M8 to mint the DRAFT and stores the returned id in `triage_call.linked_encounter_id`, and
 * M8's own `m8.encounter.signed` is what advances the call to `documented`.
 *
 * THE SEAM IS NOT IDEMPOTENT ON `triage_call_id`, contrary to §2.6. M8 published exactly one method,
 * `createDraftEncounter(input: CreateEncounterInput)`, and that input carries no triage-call id at all —
 * there is nothing for M8 to dedupe on, so a second call mints a SECOND draft encounter. That matters
 * because the §4.8 `m19.encounter-creator.consumer` retries five times: the double-create is the LIKELY
 * failure, not a theoretical one. M19 therefore owns the guard itself (`../clinical/encounter-link`), on
 * the conditional `linked_encounter_id IS NULL` write.
 */
export function getEncounterCreator(): EncounterCreator {
  return getSeam("EncounterCreator");
}

/**
 * M19 CONSUMES M11's §2.8 D14 `OrderSignatureProvider` — the one MUTATE seam M19 touches (D9 / §7.7).
 *
 * It is a signature PRIMITIVE over an EXISTING target, not an order factory: `recordVerbalOrder` takes
 * `(targetKind, targetId)` and attaches the RN's attestation plus M11's 48-hour countersignature deadline.
 * §7.7's "the panel opens M11's verbal-order modal" is what creates the order row; M19's call records the
 * verbal attestation against it and keeps the id. M19 mints no order and writes no M11 schema.
 */
export function getOrderSignatureProvider(): OrderSignatureProvider {
  return getSeam("OrderSignatureProvider");
}

/**
 * M19 CONSUMES M11's §4.3 `OrderProvider` — the read-back that proves a `verbal_order_recorded` disposition names a
 * REAL order for THIS patient before the id is stored on the call (GAP-134). Strictly read-only.
 */
export function getOrderProvider(): OrderProvider {
  return getSeam("OrderProvider");
}

/**
 * M19 CONSUMES M12's §2.10 D17 `RefillInboxProvider` — D15's "is this caller asking for a refill they
 * already have pending?" read. STRICTLY read-only: a refill M19 authorizes during a call is the
 * `prn_intervention_authorized` disposition plus the `m19.triage_call.disposition_selected` outbox event
 * M12's own consumer acts on, never a write through this seam.
 */
export function getRefillInboxProvider(): RefillInboxProvider {
  return getSeam("RefillInboxProvider");
}

/**
 * M19 CONSUMES M12's §2.10 D17 `MedicationOrderProvider` — the active-medication list the triage panel
 * shows at intake (D15) and the by-id read that validates a `prn_intervention_authorized` target.
 * `getControlledSubstanceFlag` is annotated by M12 as an M19 surface: whether the 2 a.m. PRN the caller is
 * asking about is a Schedule II changes what the RN may authorize by phone.
 */
export function getMedicationOrderProvider(): MedicationOrderProvider {
  return getSeam("MedicationOrderProvider");
}

// ── §4.4 / §8.6 the two ADVISORY M32 seams (D11 / D12), added at M19-T06 ─────────────────────────────
//
// Both stand on NON-THROWING deny-stubs until M32 lands (`apps/backend/src/bootstrap/seams/providers.ts`),
// which is the whole reason these accessors are safe to call from the intake path: architecture §17 and
// D11/D12 forbid either advisory from gating anything, so an unlanded M32 must degrade to a disabled AI
// block (§8.6: "visibly disabled — no silent fallback or guess"), never to a failed call-open. The
// `unavailable` arm is a VALUE the caller branches on, distinct from the model having no suggestion.
//
// The CONSUMER services these feed (the D12 suggestion handler and the D11 intake advisory loader) are
// spec §10 tasks 39/40 and land with the M19-T07 route layer; what M19-T06 owns is the registered,
// boot-validated contract they will resolve.

/**
 * M19 CONSUMES M32's §8.6 `ProtocolSuggestionProvider` (D12). ADVISORY: the suggestion is recorded on
 * `triage_call.suggested_protocol_id` / `suggested_protocol_confidence` and DISPLAYED; the clinician must
 * explicitly select or override, and nothing M32 returns may move a `triage_call` row.
 */
export function getProtocolSuggestionProvider(): ProtocolSuggestionProvider {
  return getSeam("ProtocolSuggestionProvider");
}

/**
 * M19 CONSUMES M32's §8.6 `HospitalizationRiskProvider` (D11). ADVISORY: the band is recorded on
 * `triage_call.hospitalization_risk_band` and shown in the panel header; it gates nothing, alters no
 * disposition option, and is EXCLUDED from the M31 portal projection (`PortalTriageSummary` has no field
 * for it, by construction).
 */
export function getHospitalizationRiskProvider(): HospitalizationRiskProvider {
  return getSeam("HospitalizationRiskProvider");
}
