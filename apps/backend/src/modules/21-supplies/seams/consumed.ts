// apps/backend/src/modules/21-supplies/seams/consumed.ts — the seams M21 CONSUMES (M21-T04).
//
// Architecture §25.15: M21 never imports M11's or M6's Drizzle schema. Every cross-module fact the §4.5.1
// inbound consumers need — the patient/admission/status behind an `m11.order.supply_fulfillment_requested`
// (M11), and the provider entity + discharge posture that decides whether the request is still worth
// filling (M6) — is resolved through the M1 boot-registered seam registry and passed into the pure
// deciders in `../consumers` as a plain value.
//
// Resolving through `getSeam` is why M21's manifest `dependsOn` gains M1 (the registry lives in
// `apps/backend/src/bootstrap`, which is M1 code). It does NOT gain 5 or 6: the CONTRACT types are leaf
// `@chartwarden/types` (ADR-0005 D1/D2) and the binding is runtime, exactly the shape M15-T03 and M16-T03 use.
//
// The seams M21 PUBLISHES (§4.8 `SupplyFulfillmentProvider`, `ComfortKitInventoryReader`, …) land in
// M21-T05.
import type {
  AdmissionStatusReader,
  DeathDischargeReader,
  OrderProvider,
  PatientAddressReader,
} from "@chartwarden/types";
import { getSeam } from "../../../bootstrap/index";

/**
 * M21 CONSUMES M11's §4.3 `OrderProvider` — the §2.8 logical-FK check behind
 * `supply_request.source_order_id`, and the only way to learn WHO the order is for.
 *
 * `m11.order.supply_fulfillment_requested` carries `{ orderId, kind, supplyDetail, … }` and no patient:
 * M11's aggregate is the order, and its payload says what was ordered, not who for. Every M21 PHI row
 * needs `patient_id` + `admission_id` NOT NULL, so the cascade is a read-back, not a projection of the
 * event. `getOrder` is the method M21-T04 added to the seam for exactly this (the store read behind it is
 * M11-T05 vintage).
 */
export function getOrderProvider(): OrderProvider {
  return getSeam("OrderProvider");
}

/**
 * M21 CONSUMES M6's §4.7 `AdmissionStatusReader` — the `provider_entity_id` every M21 PHI table carries
 * NOT NULL (supply cost rolls per CCN to the M27 cost report, M21-F06/ARCH-011), plus the admission status
 * and discharge date behind §7.1's two pre-dispatch cancellation edges.
 *
 * §7.1 is explicit that a patient who died or was discharged between M11's emit and M21's consume still
 * gets the ROW — created and then immediately cancelled with the reason recorded — rather than a silently
 * dropped delivery. That is only decidable with the admission read, which is why it happens here and not
 * in the pure decider.
 */
export function getAdmissionStatusReader(): AdmissionStatusReader {
  return getSeam("AdmissionStatusReader");
}

/**
 * M21 CONSUMES M6's §4.11 `DeathDischargeReader` — the ONE discriminator §7.1 needs and
 * `AdmissionStatusReader` cannot give: `AdmissionSummary.status` reads `discharged` for a death and a live
 * discharge alike, and the two cascade edges record different cancellation reasons.
 *
 * Read on the discharged branch only, and never load-bearing: an unbound or erroring reader degrades the
 * reason token, it does not stop the cancellation (`../consumers/order-context`).
 */
export function getDeathDischargeReader(): DeathDischargeReader {
  return getSeam("DeathDischargeReader");
}

/**
 * M21 CONSUMES M5's `PatientAddressReader.primaryAddress` (F-229 built it; F-232 is its first consumer) — the
 * delivery-address SNAPSHOT a `dme`/`supply` `supply_request.data.deliveryAddress` carries (§2.1 / D7).
 *
 * PULLED at consume time, never pushed: `m11.order.supply_fulfillment_requested` carries ids + `supplyDetail`
 * only, and a street address is PHI that must not ride the outbox. Org-explicit (RLS + an explicit
 * `organization_id` predicate), so it is safe from a relay tick. It opens its OWN org context, so the intake
 * consumer calls it OUTSIDE its own transaction (a second pooled connection held from inside one would
 * self-deadlock the pool under concurrency).
 */
export function getPatientAddressReader(): PatientAddressReader {
  return getSeam("PatientAddressReader");
}
