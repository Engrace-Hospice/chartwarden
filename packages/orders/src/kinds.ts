/**
 * Canonical M11 payload registry.
 *
 * The Order envelope stays generic; this registry is the runtime
 * discriminator for kind-specific payload validation.
 */

import { FormatRegistry, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { OrderKind } from "@chartwarden/types";

// TypeBox's `Value` treats an UNREGISTERED format as a hard failure ("Unknown format 'uuid'"), so the
// `uuid`/`date-time` fields below only validate when some other module happened to register the checkers
// first (the process-global registry). F-232's `dme.v2`/`supply.v2` carry a `skuId` uuid, so register
// idempotently here rather than depend on import order (the `@chartwarden/supplies` `kinds/formats.ts` precedent;
// both definitions are the same RFC-4122 / `Date.parse` pair, and `Has` is checked before `Set`).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_RE.test(v));
}
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)));
}

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
 * Every payload version M11 accepts per kind (F-232). `ORDER_KIND_VERSION` above stays the DEFAULT a new order
 * is stamped with — bumping it would make every existing dme/supply draft (the order editor, the IDG-spawned
 * orders, standing-order templates) strict overnight. A caller opts into a later version by naming it on
 * create (`kindVersion`); an order validates under the version it was stamped with, forever.
 *
 * `dme.v2` / `supply.v2` are the FIRST published dme/supply contracts: the smallest field set M21's
 * fulfillment intake needs to bind `m21 <- m11.order.supply_fulfillment_requested` (which SKU, how many).
 * They are CLOSED (`additionalProperties: false`) on purpose — no delivery address rides an order (M21 pulls
 * it through M5's `PatientAddressReader.primaryAddress` at consume time, never through the outbox) and no
 * HCPCS code rides it either (M21 reads it from `supply_item.hcpcs`). `comfort_kit` has no v2: its kit-SKU
 * -> template mapping, per-line contents, pharmacy dispatch mode and IPU room are not derivable from the
 * order (see docs/history/outbox-248-builds.md, F-232).
 */
export const ORDER_KIND_SUPPORTED_VERSIONS: Record<OrderKind, readonly string[]> = {
  lab: ["lab.v1"],
  dme: ["dme.v1", "dme.v2"],
  level_of_care_change: ["level_of_care_change.v1"],
  recertification: ["recertification.v1"],
  comfort_kit: ["comfort_kit.v1"],
  supply: ["supply.v1", "supply.v2"],
  ancillary_service: ["ancillary_service.v1"],
  idg_requested: ["idg_requested.v1"],
};

/**
 * The `kindVersion` a new order is stamped with: the kind's `.v1` baseline unless the caller named a later
 * supported one. `null` = the requested version is not supported for the kind (the caller rejects it).
 */
export function resolveOrderKindVersion(kind: OrderKind, requested?: string | null): string | null {
  const version = requested ?? `${kind}.v1`;
  return ORDER_KIND_SUPPORTED_VERSIONS[kind].includes(version) ? version : null;
}

const quantity = Type.Integer({ minimum: 1 });

/** Versioned schemas that supersede the per-kind default for a specific `kindVersion`. */
const versionedSchemas: Record<string, TSchema> = {
  "dme.v2": Type.Object(
    {
      /** An M21 `supply_item` id (the catalog is platform-shared; the SKU's HCPCS is read from it). */
      skuId: uuid,
      quantity,
      rentalCadence: Type.Optional(
        Type.Union([Type.Literal("monthly"), Type.Literal("one_time_purchase")]),
      ),
      needsInstallation: Type.Optional(Type.Boolean()),
      needsPatientEducation: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  "supply.v2": Type.Object(
    {
      skuId: uuid,
      quantity,
      /** Falls back to the SKU's `supply_item.default_unit` when omitted. */
      unit: Type.Optional(Type.String({ minLength: 1, maxLength: 16 })),
    },
    { additionalProperties: false },
  ),
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
  if (!ORDER_KIND_SUPPORTED_VERSIONS[kind].includes(kindVersion)) {
    return [
      {
        field: "kindVersion",
        message: `Unsupported ${kind} payload version.`,
      },
    ];
  }

  const schema = versionedSchemas[kindVersion] ?? schemas[kind];

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
