// @chartwarden/supplies — §2.1 `kind='dme'` request payload (D1).

import { type Static, Type } from "@sinclair/typebox";

import { DeliveryWindowSchema, HCPCS_PATTERN, PatientAddressSnapshotSchema } from "../shared";

/** §2.1 — rental vs purchase. The value decides whether `received_confirmed` auto-completes: a purchase
 *  does, a monthly rental stays open for the rental life and completes only on M11's discontinuation. */
export const DmeRentalCadenceSchema = Type.Union([
  Type.Literal("monthly"),
  Type.Literal("one_time_purchase"),
]);

export const DmeRequestDataSchema = Type.Composite(
  [
    Type.Object(
      {
        skuId: Type.String({ format: "uuid" }),
        /** Resolved against M38 at write time; required because every DME line is billable. */
        hcpcs: Type.String({ pattern: HCPCS_PATTERN }),
        /** NU | RR | UE | KX from the M38 value set. Four is the X12 2400 SV1 ceiling, not a guess. */
        hcpcsModifiers: Type.Array(Type.String({ minLength: 2, maxLength: 2 }), { maxItems: 4 }),
        quantity: Type.Integer({ minimum: 1 }),
        rentalCadence: Type.Optional(DmeRentalCadenceSchema),
        /** Vendor-side identifier; informational only, never routed on. */
        vendorMfrSku: Type.Optional(Type.String({ maxLength: 64 })),
        deliveryAddress: PatientAddressSnapshotSchema,
        needsInstallation: Type.Boolean({ default: false }),
        needsPatientEducation: Type.Boolean({ default: false }),
      },
      { additionalProperties: false },
    ),
    DeliveryWindowSchema,
  ],
  { additionalProperties: false },
);
export type DmeRequestData = Static<typeof DmeRequestDataSchema>;
