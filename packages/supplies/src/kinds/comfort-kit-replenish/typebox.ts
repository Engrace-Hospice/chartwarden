// @chartwarden/supplies — §2.1 `kind='comfort_kit_replenish'` request payload (D1).

import { type Static, Type } from "@sinclair/typebox";

import { KIT_CONTENT_MAX_ITEMS, KIT_CONTENT_MIN_ITEMS } from "../../policy";
import {
  ComfortKitMedicationContentSchema,
  DeliveryWindowSchema,
  PatientAddressSnapshotSchema,
} from "../shared";

export const SupplyReplenishUrgencySchema = Type.Union([
  Type.Literal("routine"),
  Type.Literal("urgent"),
]);

export const ComfortKitReplenishRequestDataSchema = Type.Composite(
  [
    Type.Object(
      {
        /** Logical FK to M13's `comfort_kit_deployment` — the kit being topped up. */
        sourceDeploymentId: Type.String({ format: "uuid" }),
        /** The `m13.comfort_kit.replenishment_needed` outbox row that drove this. Required: a replenish
         *  request has no M11 order behind it, so this event IS the request's provenance. */
        triggeringReplenishmentEventId: Type.String({ format: "uuid" }),
        urgencyKind: SupplyReplenishUrgencySchema,
        deliveryAddress: PatientAddressSnapshotSchema,
        /** A SUBSET of the original deployment — only the lines that crossed threshold. The M13 event
         *  decides which; M21 never widens it back to the full kit floor. */
        contents: Type.Array(ComfortKitMedicationContentSchema, {
          minItems: KIT_CONTENT_MIN_ITEMS,
          maxItems: KIT_CONTENT_MAX_ITEMS,
        }),
      },
      { additionalProperties: false },
    ),
    DeliveryWindowSchema,
  ],
  { additionalProperties: false },
);
export type ComfortKitReplenishRequestData = Static<typeof ComfortKitReplenishRequestDataSchema>;
