/** Canonical M11 payload registry.  The envelope stays generic; this is the runtime discriminator. */
import { type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { OrderKind } from "@wardenx/types";

const iso = Type.String({ format: "date-time" });
const uuid = Type.String({ format: "uuid" });
const level = Type.Union(["rhc", "chc", "irc", "gip"].map((x) => Type.Literal(x)));
const openObject = Type.Object({}, { additionalProperties: true });

export const ORDER_KIND_VERSION: Record<OrderKind, string> = {
  lab: "lab.v1",
  dme: "dme.v1",
  level_of_care_change: "level_of_care_change.v1",
  recertification: "recertification.v1",
  comfort_kit: "comfort_kit.v1",
  supply: "supply.v1",
  ancillary_service: "ancillary_service.v1",
  idg_requested: "idg_requested.v1",
};

const schemas: Record<OrderKind, TSchema> = {
  lab: Type.Object({
    testCodes: Type.Array(
      Type.Object({
        system: Type.Literal("http://loinc.org"),
        code: Type.String({ pattern: "^[0-9]{1,5}-[0-9]$" }),
        display: Type.String(),
      }),
      { minItems: 1 },
    ),
    priority: Type.Union([Type.Literal("routine"), Type.Literal("stat"), Type.Literal("asap")]),
    fastingRequired: Type.Boolean(),
    collectionInstructions: Type.Optional(Type.String({ maxLength: 1000 })),
    specimenSource: Type.Optional(Type.String()),
    routingLabId: Type.Optional(uuid),
    clinicalJustification: Type.Optional(Type.String({ maxLength: 2000 })),
    notes: Type.Optional(Type.String({ maxLength: 2000 })),
  }),
  level_of_care_change: Type.Object({
    fromLevel: level,
    toLevel: level,
    effectiveAt: iso,
    clinicalJustification: Type.String({ minLength: 20, maxLength: 2000 }),
    expectedDurationHours: Type.Optional(Type.Integer({ minimum: 0, maximum: 5000 })),
  }),
  comfort_kit: Type.Object({
    kitSku: Type.String({ minLength: 1 }),
    deploymentSite: Type.Union(["home", "alf", "snf", "ipu"].map((x) => Type.Literal(x))),
    preferredDeliveryWindow: Type.Optional(Type.Object({ startAt: iso, endAt: iso })),
    notes: Type.Optional(Type.String({ maxLength: 1000 })),
  }),
  recertification: Type.Object({
    periodEndDate: Type.String({ format: "date" }),
    certifyingPhysicianMdmId: uuid,
  }),
  idg_requested: Type.Object({
    requestedKind: Type.String({ minLength: 1 }),
    narrative: Type.String({ minLength: 1, maxLength: 2000 }),
    recommendedTimeframe: Type.Optional(Type.String({ maxLength: 500 })),
    triggeringProblemId: Type.Optional(uuid),
  }),
  // The v0.4 spec names these contracts but does not publish their field shapes. Keep them explicitly
  // extensible until M11 owns a reviewed contract; validation still prevents non-object payloads.
  dme: openObject,
  supply: openObject,
  ancillary_service: openObject,
};

export interface OrderPayloadFinding {
  field: string;
  message: string;
}
export function validateOrderData(
  kind: OrderKind,
  kindVersion: string,
  data: unknown,
): OrderPayloadFinding[] {
  if (kindVersion !== ORDER_KIND_VERSION[kind])
    return [{ field: "kindVersion", message: `Unsupported ${kind} payload version.` }];
  const schema = schemas[kind];
  if (Value.Check(schema, data)) {
    if (
      kind === "level_of_care_change" &&
      (data as { fromLevel: string }).fromLevel === (data as { toLevel: string }).toLevel
    )
      return [
        { field: "toLevel", message: "The requested level must differ from the current level." },
      ];
    return [];
  }
  return [...Value.Errors(schema, data)].map((x) => ({
    field: x.path.replace(/^\//, "").replaceAll("/", ".") || "data",
    message: x.message,
  }));
}
export const ORDER_KIND_REGISTRY = Object.freeze(
  Object.fromEntries(
    Object.entries(schemas).map(([kind, schema]) => [
      kind,
      { version: ORDER_KIND_VERSION[kind as OrderKind], schema },
    ]),
  ) as Record<OrderKind, { version: string; schema: TSchema }>,
);
