// @wardenx/supplies — the §2.1 building blocks every per-kind `supply_request.data` schema shares.
//
// PURE — TypeBox declarations and nothing else.

import { type Static, Type } from "@sinclair/typebox";

import { FREE_TEXT_MAX_LENGTH, REPLENISHMENT_THRESHOLD_PCT_DEFAULT } from "../policy";
// Side-effect import: registers the `uuid` / `date-time` format checkers the schemas below declare.
// Without it TypeBox's `Value` rejects EVERY payload with "Unknown format", valid ones included.
import "./formats";

/** HCPCS Level II: one letter, four digits. */
export const HCPCS_PATTERN = "^[A-Z]\\d{4}$";

/** NDC in either 5-4-2 or 5-3-2 segmentation. */
export const NDC_PATTERN = "^\\d{5}-\\d{4}-\\d{2}$|^\\d{5}-\\d{3}-\\d{2}$";

/**
 * §2.1 — the delivery address captured AT REQUEST TIME and thereafter immutable.
 *
 * A snapshot, not a reference to M5's current address, on purpose: the question a delivery dispute asks is
 * "where were we told to take it", and re-resolving the patient's address later would answer a different
 * question. It is also why the whole object is denylist-scrubbed alongside `deliveryInstructions`.
 */
export const PatientAddressSnapshotSchema = Type.Object(
  {
    line1: Type.String({ minLength: 1, maxLength: 200 }),
    line2: Type.Optional(Type.String({ maxLength: 200 })),
    city: Type.String({ minLength: 1, maxLength: 100 }),
    state: Type.String({ minLength: 2, maxLength: 2 }),
    postalCode: Type.String({ minLength: 5, maxLength: 10 }),
    county: Type.Optional(Type.String({ maxLength: 100 })),
    capturedAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);
export type PatientAddressSnapshot = Static<typeof PatientAddressSnapshotSchema>;

/** The delivery-window + instructions block every kind carries identically. */
export const DeliveryWindowSchema = Type.Object(
  {
    deliveryWindowEarliest: Type.Optional(Type.String({ format: "date-time" })),
    deliveryWindowLatest: Type.Optional(Type.String({ format: "date-time" })),
    deliveryInstructions: Type.Optional(Type.String({ maxLength: FREE_TEXT_MAX_LENGTH })),
  },
  { additionalProperties: false },
);

export const ControlledSubstanceScheduleSchema = Type.Union([
  Type.Literal("CII"),
  Type.Literal("CIII"),
  Type.Literal("CIV"),
  Type.Literal("CV"),
]);

/**
 * §2.1 — one REQUESTED kit medication line.
 *
 * Deliberately carries no `lotNumber` / `expirationDate` / `dispatchedQuantity`: those are properties of a
 * particular physical fulfillment, not of the order, and live on `comfort_kit_dispatch.dispatched_contents`.
 * Conflating them is how a re-dispatch silently overwrites the lot the first kit actually shipped with.
 */
export const ComfortKitMedicationContentSchema = Type.Object(
  {
    /** Logical FK to M12; null for the IPU-stock kit, which has no per-patient prescription behind it. */
    medicationOrderId: Type.Optional(Type.String({ format: "uuid" })),
    comfortKitTemplateMedicationId: Type.String({ format: "uuid" }),
    rxNorm: Type.String({ minLength: 1, maxLength: 32 }),
    ndc: Type.Optional(Type.String({ pattern: NDC_PATTERN })),
    drugName: Type.String({ minLength: 1, maxLength: 200 }),
    strength: Type.String({ minLength: 1, maxLength: 64 }),
    dosageForm: Type.String({ minLength: 1, maxLength: 32 }),
    routeOfAdministration: Type.String({ minLength: 1, maxLength: 32 }),
    isControlledSubstance: Type.Boolean(),
    controlledSubstanceSchedule: Type.Optional(ControlledSubstanceScheduleSchema),
    expectedQuantity: Type.Number({ exclusiveMinimum: 0 }),
    expectedUnit: Type.String({ minLength: 1, maxLength: 16 }),
    replenishmentThresholdPct: Type.Number({
      minimum: 0,
      maximum: 1,
      default: REPLENISHMENT_THRESHOLD_PCT_DEFAULT,
    }),
  },
  { additionalProperties: false },
);
export type ComfortKitMedicationContent = Static<typeof ComfortKitMedicationContentSchema>;

export const PharmacyDispatchModeSchema = Type.Union([
  Type.Literal("supply_hub_dispatch"),
  Type.Literal("partner_pharmacy_dispatch"),
  Type.Literal("dosespot_to_partner_pharmacy"),
]);

export const DeploymentSiteSchema = Type.Union([
  Type.Literal("home"),
  Type.Literal("alf"),
  Type.Literal("snf_residence"),
  Type.Literal("ipu_room"),
]);
