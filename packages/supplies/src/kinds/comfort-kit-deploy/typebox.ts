// @wardenx/supplies — §2.1 `kind='comfort_kit_deploy'` request payload (D1 / D6 / D17).

import { type Static, Type } from "@sinclair/typebox";

import { FREE_TEXT_MAX_LENGTH, KIT_CONTENT_MAX_ITEMS, KIT_CONTENT_MIN_ITEMS } from "../../policy";
import {
  ComfortKitMedicationContentSchema,
  DeliveryWindowSchema,
  DeploymentSiteSchema,
  PatientAddressSnapshotSchema,
  PharmacyDispatchModeSchema,
} from "../shared";

export const ComfortKitDeployRequestDataSchema = Type.Composite(
  [
    Type.Object(
      {
        comfortKitTemplateId: Type.String({ format: "uuid" }),
        deploymentSite: DeploymentSiteSchema,
        /** Required when `deploymentSite='ipu_room'`, forbidden otherwise — the M37 forward seam. The
         *  either/or is a cross-field rule (`validate.ts`), not a schema shape: TypeBox can express the
         *  union, but the error a coordinator needs to read is "pick a room", not "no variant matched". */
        ipuRoomId: Type.Optional(Type.String({ format: "uuid" })),
        /** Omitted for `ipu_room` — an inpatient room has no delivery address to attest against. */
        deliveryAddress: Type.Optional(PatientAddressSnapshotSchema),
        pharmacyDispatchMode: PharmacyDispatchModeSchema,
        contents: Type.Array(ComfortKitMedicationContentSchema, {
          minItems: KIT_CONTENT_MIN_ITEMS,
          maxItems: KIT_CONTENT_MAX_ITEMS,
        }),
        controlledSubstanceHandlingNotes: Type.Optional(
          Type.String({ maxLength: FREE_TEXT_MAX_LENGTH }),
        ),
      },
      { additionalProperties: false },
    ),
    DeliveryWindowSchema,
  ],
  { additionalProperties: false },
);
export type ComfortKitDeployRequestData = Static<typeof ComfortKitDeployRequestDataSchema>;
