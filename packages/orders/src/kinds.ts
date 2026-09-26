/**
 * Canonical M11 payload registry.
 *
 * The Order envelope stays generic; this registry is the runtime
 * discriminator for kind-specific payload validation.
 */

import { type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { OrderKind } from "@wardenx/types";

const iso = Type.String({ format: "date-time" });
const uuid = Type.String({ format: "uuid" });

const level = Type.Union(["rhc", "chc", "irc", "gip"].map((value) => Type.Literal(value)));

const openObject = Type.Object(
  {},
  {
    additionalProperties: true,
  },
);

/**
 * Whether M11 has a published, field-level contract for the kind's `data`.
 *
 * `contract_not_published` is intentional: it is not a partially implemented
 * canonical contract and must not be presented as one by a producer or UI.
 */
export type OrderPayloadContractStatus = "canonical_contract_found" | "contract_not_published";

export const ORDER_KIND_CONTRACT_STATUS: Record<OrderKind, OrderPayloadContractStatus> = {
  lab: "canonical_contract_found",
  dme: "contract_not_published",
  level_of_care_change: "canonical_contract_found",
  recertification: "canonical_contract_found",
  comfort_kit: "canonical_contract_found",
  supply: "contract_not_published",
  ancillary_service: "contract_not_published",
  idg_requested: "canonical_contract_found",
};

/**
 * Canonical payload version currently supported for each M11 Order kind.
 */
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

/**
 * Canonical payload schemas.
 *
 * DME, Supply and Ancillary Service intentionally remain extensible until
 * reviewed canonical field contracts are published for those kinds.
 */
const schemas: Record<OrderKind, TSchema> = {
  lab: Type.Object({
    testCodes: Type.Array(
      Type.Object({
        system: Type.Literal("http://loinc.org"),

        code: Type.String({
          pattern: "^[0-9]{1,5}-[0-9]$",
        }),

        display: Type.String(),
      }),
      {
        minItems: 1,
      },
    ),

    fastingRequired: Type.Boolean(),

    collectionInstructions: Type.Optional(
      Type.String({
        maxLength: 1000,
      }),
    ),

    specimenSource: Type.Optional(Type.String()),

    routingLabId: Type.Optional(uuid),

    clinicalJustification: Type.Optional(
      Type.String({
        maxLength: 2000,
      }),
    ),

    notes: Type.Optional(
      Type.String({
        maxLength: 2000,
      }),
    ),
  }),

  level_of_care_change: Type.Object({
    fromLevel: level,

    toLevel: level,

    effectiveAt: iso,

    clinicalJustification: Type.String({
      minLength: 20,
      maxLength: 2000,
    }),

    expectedDurationHours: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 5000,
      }),
    ),
  }),

  comfort_kit: Type.Object({
    kitSku: Type.String({
      minLength: 1,
    }),

    deploymentSite: Type.Union(["home", "alf", "snf", "ipu"].map((value) => Type.Literal(value))),

    preferredDeliveryWindow: Type.Optional(
      Type.Object({
        startAt: iso,
        endAt: iso,
      }),
    ),

    notes: Type.Optional(
      Type.String({
        maxLength: 1000,
      }),
    ),
  }),

  recertification: Type.Object({
    periodEndDate: Type.String({
      format: "date",
    }),

    certifyingPhysicianMdmId: uuid,
  }),

  idg_requested: Type.Object({
    requestedKind: Type.String({
      minLength: 1,
    }),

    narrative: Type.String({
      minLength: 1,
      maxLength: 2000,
    }),

    recommendedTimeframe: Type.Optional(
      Type.String({
        maxLength: 500,
      }),
    ),

    triggeringProblemId: Type.Optional(uuid),
  }),

  /**
   * The M11 v0.4 specification names these contracts but does not publish
   * their reviewed required-field shapes.
   *
   * Keep them explicitly extensible instead of inventing clinical fields.
   * Validation still requires the payload itself to be an object.
   */
  dme: openObject,
  supply: openObject,
  ancillary_service: openObject,
};

export interface OrderPayloadFinding {
  field: string;
  message: string;
}

/**
 * Validate an M11 Order payload against its canonical kind/version contract.
 *
 * Drafts may remain incomplete. Consumers decide when these findings become
 * blocking — for example when requesting signature.
 */
export function validateOrderData(
  kind: OrderKind,
  kindVersion: string,
  data: unknown,
): OrderPayloadFinding[] {
  const expectedVersion = ORDER_KIND_VERSION[kind];

  if (kindVersion !== expectedVersion) {
    return [
      {
        field: "kindVersion",
        message: `Unsupported ${kind} payload version.`,
      },
    ];
  }

  const schema = schemas[kind];

  if (!Value.Check(schema, data)) {
    return [...Value.Errors(schema, data)].map((error) => ({
      field: error.path.replace(/^\//, "").replaceAll("/", ".") || "data",
      message: error.message,
    }));
  }

  /**
   * Cross-field validation:
   * a level-of-care change must actually request a different level.
   */
  if (kind === "level_of_care_change") {
    const payload = data as {
      fromLevel: string;
      toLevel: string;
    };

    if (payload.fromLevel === payload.toLevel) {
      return [
        {
          field: "toLevel",
          message: "The requested level must differ from the current level.",
        },
      ];
    }
  }

  return [];
}

/**
 * Public canonical M11 Order-kind registry.
 */
export const ORDER_KIND_REGISTRY = Object.freeze(
  Object.fromEntries(
    Object.entries(schemas).map(([kind, schema]) => [
      kind,
      {
        version: ORDER_KIND_VERSION[kind as OrderKind],
        contractStatus: ORDER_KIND_CONTRACT_STATUS[kind as OrderKind],
        schema,
      },
    ]),
  ) as Record<
    OrderKind,
    {
      version: string;
      contractStatus: OrderPayloadContractStatus;
      schema: TSchema;
    }
  >,
);
