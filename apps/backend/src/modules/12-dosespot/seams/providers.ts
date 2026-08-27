// apps/backend/src/modules/12-dosespot/seams/providers.ts — M12-T07 the §2.10 D17 seam implementations: pure
// orchestration over an injected {@link DoseSpotSeamStore}. Each returns the leaf-typed seam interface
// (@wardenx/types) the M1 registry validates and M13/M14/M19/M28/M30/M31/M33 resolve. The providers add NO
// tenant logic — RLS scopes every store read by the consumer's `app.org_id` (§3.6); they project store DTOs and
// derive the read-side signals (administration gate, FHIR projection, lay-language portal summary with the
// §7.8 / D7 SUD redaction). Both seams are READ-only — M12 owns the medication-order lifecycle internally and
// never mutates through a seam. Mirrors the M9/M10/M11 read-seam provider precedents.
import type {
  FhirMedicationRequestPayload,
  MedicationOrderDto,
  MedicationOrderProvider,
  MedicationOrderStatus,
  PortalMedicationSummary,
  RefillInboxProvider,
  RefillRequestDto,
} from "@wardenx/types";
import type { DoseSpotSeamStore } from "./store";

/** The temporal anchor `getMedicationsSince` keys on: when the medication became clinically effective
 * (activated), else when it was signed. Null until the order is at least signed (drafts never match a "since"). */
function sinceAnchor(o: MedicationOrderDto): string | null {
  return o.activatedAt ?? o.signedAt;
}

/** The M13 administration-context block-reason taxonomy (mirrors the seam DTO's `blockedReasons` union). */
type AdministrationBlockReason =
  | "not_active"
  | "discontinued"
  | "replaced"
  | "expired_unsigned"
  | "transmission_failed";

/**
 * §2.2 — the statuses M13 may record an administration against.
 *
 * `active` is the obvious one. `verbal_pending` is here because this module's own spec §2.3 says so in
 * as many words: a verbal order "is **active for clinical execution** during this window for
 * non-controlled substances (per CMS — verbal orders are valid orders pending signature) but visibly
 * marked as 'pending prescriber signature'", and "M13 eMAR may record administrations". The
 * implementation blocked it anyway (F-058) — which is the 2 AM verbal-order workflow this module's own
 * §1 names as the thing it exists for, refused by the gate meant to protect it. A CONTROLLED verbal
 * order cannot exist in Phase 1 (D18 feature-flag-OFF, `EPCS_VERBAL_NOT_PERMITTED` at `recordVerbal`),
 * so admitting `verbal_pending` here cannot admit an unwitnessed controlled substance.
 *
 * Everything else stays blocked, `signed` included: a signed order that is not being e-prescribed now
 * ACTIVATES on signature (F-058), and one that owes a transmission is genuinely not ready to give.
 */
const ADMINISTRABLE_STATUSES: ReadonlySet<MedicationOrderStatus> = new Set<MedicationOrderStatus>([
  "active",
  "verbal_pending",
]);

/** The M13 administration-context block reasons for a non-administrable medication order (empty ⇒ allowed). */
function blockedReasonsFor(
  order: MedicationOrderDto,
  isReplaced: boolean,
): AdministrationBlockReason[] {
  const reasons: AdministrationBlockReason[] = [];
  if (order.status === "discontinued") reasons.push("discontinued");
  else if (order.status === "expired_unsigned") reasons.push("expired_unsigned");
  else if (order.status === "transmission_failed" || order.status === "nack_received")
    reasons.push("transmission_failed");
  else if (!ADMINISTRABLE_STATUSES.has(order.status)) reasons.push("not_active");
  // An order superseded by a newer one (a sibling pointing at it via `replacesMedicationOrderId`) is blocked
  // even if its own status is still active — M13 must administer the replacement, not the stale row.
  if (isReplaced) reasons.push("replaced");
  return reasons;
}

/** Map the M12 lifecycle status onto the narrow FHIR `MedicationRequest.status` value set (§2.10 / M28). */
function fhirStatusOf(status: MedicationOrderStatus): FhirMedicationRequestPayload["status"] {
  switch (status) {
    case "active":
      return "active";
    case "discontinued":
      return "stopped";
    case "completed":
      return "completed";
    case "draft":
    case "pending_signature":
    case "verbal_pending":
    case "epcs_identity_pending":
      return "draft";
    default:
      return "unknown";
  }
}

/** A lay-language sig from the server-canonicalized structured sig (M31 owns the final phrasing; this is the
 * default projection M12 publishes). PRN orders read "as needed"; the free-text sig (PHI, D14) never appears. */
function layInstructions(order: MedicationOrderDto): string {
  const s = order.sigStructured;
  const base = `Take ${s.doseQuantity} ${s.doseUnit} by ${s.route}, ${s.frequencyCode}`;
  return s.asNeeded ? `${base} as needed` : base;
}

/**
 * §2.10 D17 MedicationOrderProvider over the store — the medication-order read seam M13 (eMAR administration
 * context), M14 (IDG packet), M19/M30/M33 (derived signals + cost basis + quality), M28 (FHIR), and M31
 * (portal) consume. Pure projection + the derived read-side signals; RLS pins the tenant.
 */
export function createMedicationOrderProvider(store: DoseSpotSeamStore): MedicationOrderProvider {
  return {
    async getActiveMedications(_orgId, patientId) {
      const all = await store.medicationOrdersForPatient(patientId);
      return all.filter((m) => m.status === "active");
    },
    async getMedicationsSince(_orgId, patientId, sinceIso) {
      const all = await store.medicationOrdersForPatient(patientId);
      return all
        .filter((m) => {
          const anchor = sinceAnchor(m);
          return anchor !== null && anchor >= sinceIso;
        })
        .sort((a, b) => {
          const av = sinceAnchor(a) ?? "";
          const bv = sinceAnchor(b) ?? "";
          return av < bv ? -1 : av > bv ? 1 : 0;
        });
    },
    async getMedicationOrder(_orgId, medicationOrderId) {
      return store.medicationOrderById(medicationOrderId);
    },
    async listForAdmission(_orgId, admissionId, statuses) {
      const all = await store.medicationOrdersForAdmission(admissionId);
      return statuses === undefined ? [...all] : all.filter((m) => statuses.includes(m.status));
    },
    async getAdministrationContext(_orgId, medicationOrderId) {
      const order = await store.medicationOrderById(medicationOrderId);
      if (order === null) return null;
      const siblings = await store.medicationOrdersForAdmission(order.admissionId);
      const isReplaced = siblings.some((s) => s.replacesMedicationOrderId === order.id);
      const blockedReasons = blockedReasonsFor(order, isReplaced);
      return { order, allowAdministration: blockedReasons.length === 0, blockedReasons };
    },
    async getControlledSubstanceFlag(_orgId, medicationOrderId) {
      const order = await store.medicationOrderById(medicationOrderId);
      if (order === null) return { isControlled: false, schedule: null };
      return { isControlled: order.isControlledSubstance, schedule: order.deaSchedule };
    },
    async getComfortKitDeploymentTimeline(_orgId, admissionId) {
      const timeline = await store.comfortKitTimelineForAdmission(admissionId);
      if (timeline === null) return null;
      return {
        deployedAt: timeline.deployedAt,
        firstAdministrationAt: timeline.firstAdministrationAt,
      };
    },
    async getCostBasisSummary(_orgId, admissionId, monthIso) {
      return store.costBasisForAdmissionMonth(admissionId, monthIso);
    },
    async getPortalMedicationSummary(_orgId, patientId) {
      const all = await store.medicationOrdersForPatient(patientId);
      const summary: PortalMedicationSummary[] = all
        .filter((m) => m.status === "active")
        .map((m) =>
          // §7.8 / D7 — SUD-treatment medications are redacted by default in the lay-language portal surface;
          // M12 owns the redaction rule, M31 owns the consent-gated reveal.
          m.isSudTreatment
            ? {
                medicationOrderId: m.id,
                displayName: "Confidential medication",
                instructions: "Details restricted",
                status: m.status,
                isRedacted: true,
              }
            : {
                medicationOrderId: m.id,
                displayName: `${m.drugName} ${m.strength}`.trim(),
                instructions: layInstructions(m),
                status: m.status,
                isRedacted: false,
              },
        );
      return { summary };
    },
    async asFhirMedicationRequest(_orgId, medicationOrderId) {
      const order = await store.medicationOrderById(medicationOrderId);
      if (order === null) return null;
      return {
        resourceType: "MedicationRequest",
        id: order.id,
        status: fhirStatusOf(order.status),
        intent: "order",
        subjectPatientId: order.patientId,
        medicationDisplay: `${order.drugName} ${order.strength}`.trim(),
        rxnormRxcui: order.rxnormRxcui,
        authoredOn: order.signedAt,
      };
    },
  };
}

/** A refill request still awaiting a prescriber decision (the inbox hot path). */
function isPending(r: RefillRequestDto): boolean {
  return r.status === "pending";
}

/**
 * §2.10 D17 RefillInboxProvider over the store — the refill-request read seam the prescriber inbox UI, M19
 * (on-call "any pending refills for this patient tonight?"), and M33 (SLA dashboards) consume. Pure projection
 * + the pending narrowing; RLS pins the tenant.
 */
export function createRefillInboxProvider(store: DoseSpotSeamStore): RefillInboxProvider {
  return {
    async getPendingRefillsForPrescriber(_orgId, prescriberMembershipId) {
      const all = await store.refillRequestsForPrescriber(prescriberMembershipId);
      return all.filter(isPending);
    },
    async getPendingRefillsForPatient(_orgId, patientId) {
      const all = await store.refillRequestsForPatient(patientId);
      return all.filter(isPending);
    },
    async getRefillRequestById(_orgId, refillRequestId) {
      return store.refillRequestById(refillRequestId);
    },
  };
}
