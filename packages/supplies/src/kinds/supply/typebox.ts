// @wardenx/supplies — §2.1 `kind='supply'` request payload (D1).

import { type Static, Type } from "@sinclair/typebox";

import {
  DeliveryWindowSchema,
  HCPCS_PATTERN,
  PatientAddressSnapshotSchema,
} from "../shared";

export const SupplyRequestDataSchema = Type.Composite(
  [
    Type.Object(
      {
        skuId: Type.String({ format: "uuid" }),
        /** OPTIONAL here and required on DME: a non-billable internal consumable (the agency's own gloves)
         *  legitimately has no HCPCS, and forcing a placeholder would corrupt the §3.1 billable CHECK. */
        hcpcs: Type.Optional(Type.String({ pattern: HCPCS_PATTERN })),
        quantity: Type.Integer({ minimum: 1 }),
        unit: Type.String({ minLength: 1, maxLength: 16 }),
        deliveryAddress: PatientAddressSnapshotSchema,
      },
      { additionalProperties: false },
    ),
    DeliveryWindowSchema,
  ],
  { additionalProperties: false },
);
export type SupplyRequestData = Static<typeof SupplyRequestDataSchema>;
