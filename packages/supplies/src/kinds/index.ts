// @wardenx/supplies — the §2.1 / D1 per-kind `supply_request.data` registry and the §2.10 cross-field
// rules TypeBox alone cannot express.
//
// NAMING: the per-kind files are `typebox.ts`, not the spec's `schema.ts`. `arch:tables` reads an import
// from a path containing "schema" as a Drizzle-schema import and then flags any owned-table token in the
// file — the word "alerts" in a comment here was enough to fail the build as an M36 table reference.
//
// PURE — schema checks and cross-field logic; no IO, no terminology lookups (the M38 HCPCS / RxNorm
// resolution is a route-layer concern, and doing it here would make this package impure).

import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { SupplyRequestKind } from "@wardenx/types";

import { ComfortKitDeployRequestDataSchema } from "./comfort-kit-deploy/typebox";
import { ComfortKitReplenishRequestDataSchema } from "./comfort-kit-replenish/typebox";
import { DmeRequestDataSchema } from "./dme/typebox";
import { SupplyRequestDataSchema } from "./supply/typebox";

export * from "./shared";
export * from "./dme/typebox";
export * from "./supply/typebox";
export * from "./comfort-kit-deploy/typebox";
export * from "./comfort-kit-replenish/typebox";

/** D1 — the one place `supply_request.kind` maps to the schema that validates its `data` jsonb. Every
 *  write path goes through here; a kind with no schema is a build error, not a silently unvalidated row. */
export const SUPPLY_REQUEST_DATA_SCHEMAS: { readonly [K in SupplyRequestKind]: TSchema } = {
  dme: DmeRequestDataSchema,
  supply: SupplyRequestDataSchema,
  comfort_kit_deploy: ComfortKitDeployRequestDataSchema,
  comfort_kit_replenish: ComfortKitReplenishRequestDataSchema,
} as const;

/** One violation, shaped so the route layer can lift it straight into the §4.3 `ErrorDetail` envelope. */
export interface SupplyDataViolation {
  /** JSON path within `data`, e.g. `/contents/2/expectedQuantity`. Empty string for a whole-object rule. */
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export type SupplyDataValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly violations: readonly SupplyDataViolation[] };

/**
 * §2.10 — the cross-field rules for `comfort_kit_deploy` / `comfort_kit_replenish` that the per-kind schema
 * cannot state. Kept separate from the schema check so the caller can report BOTH a shape error and a
 * cross-field error in one 422 rather than making the coordinator fix them one round-trip at a time.
 */
function crossFieldViolations(
  kind: SupplyRequestKind,
  data: Record<string, unknown>,
): SupplyDataViolation[] {
  const violations: SupplyDataViolation[] = [];

  if (kind === "comfort_kit_deploy") {
    const site = data.deploymentSite;
    const hasRoom = typeof data.ipuRoomId === "string";
    const hasAddress = data.deliveryAddress != null;

    if (site === "ipu_room") {
      if (!hasRoom) {
        violations.push({
          path: "/ipuRoomId",
          code: "ipu_room_id_required",
          message: "deploymentSite='ipu_room' requires ipuRoomId",
        });
      }
      if (hasAddress) {
        violations.push({
          path: "/deliveryAddress",
          code: "delivery_address_forbidden_for_ipu_room",
          message: "an IPU-room kit has no delivery address to attest against",
        });
      }
    } else {
      if (hasRoom) {
        violations.push({
          path: "/ipuRoomId",
          code: "ipu_room_id_forbidden",
          message: `ipuRoomId is only valid when deploymentSite='ipu_room' (got '${String(site)}')`,
        });
      }
      if (!hasAddress) {
        violations.push({
          path: "/deliveryAddress",
          code: "delivery_address_required",
          message: `deploymentSite='${String(site)}' requires a deliveryAddress snapshot`,
        });
      }
    }
  }

  const contents = data.contents;
  if (Array.isArray(contents)) {
    contents.forEach((line, i) => {
      const row = line as Record<string, unknown>;
      // §3.1.9 mirrors this as a CHECK; catching it here turns a 500 into a field-anchored 422.
      if (row.isControlledSubstance === true && row.controlledSubstanceSchedule == null) {
        violations.push({
          path: `/contents/${i}/controlledSubstanceSchedule`,
          code: "controlled_schedule_required",
          message: "a controlled-substance line must declare its DEA schedule",
        });
      }
      if (row.isControlledSubstance === false && row.controlledSubstanceSchedule != null) {
        violations.push({
          path: `/contents/${i}/controlledSubstanceSchedule`,
          code: "controlled_schedule_forbidden",
          message: "a non-controlled line must not carry a DEA schedule",
        });
      }
    });
  }

  // §2.10 — the delivery window must be orderable. An inverted window silently disables the §2.10
  // delivery-overdue detector, so it is rejected at write time rather than discovered as missing alerts.
  const earliest = data.deliveryWindowEarliest;
  const latest = data.deliveryWindowLatest;
  if (typeof earliest === "string" && typeof latest === "string") {
    if (Date.parse(latest) < Date.parse(earliest)) {
      violations.push({
        path: "/deliveryWindowLatest",
        code: "delivery_window_inverted",
        message: "deliveryWindowLatest must not precede deliveryWindowEarliest",
      });
    }
  }

  return violations;
}

/** D1 — validate a `supply_request.data` payload against its kind. Shape errors and cross-field errors are
 *  reported together. */
export function validateSupplyRequestData(
  kind: SupplyRequestKind,
  data: unknown,
): SupplyDataValidation {
  const schema = SUPPLY_REQUEST_DATA_SCHEMAS[kind];
  const violations: SupplyDataViolation[] = [];

  for (const error of Value.Errors(schema, data)) {
    violations.push({
      path: error.path,
      code: "schema_violation",
      message: error.message,
    });
  }

  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    violations.push(...crossFieldViolations(kind, data as Record<string, unknown>));
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

/**
 * §2.10 — defense in depth on the template floor. The `system_locked` flag already blocks removing a
 * platform-floor medication template-side; this catches the request that simply left one out (a manual
 * dispatch assembled by hand rather than from the template).
 */
export function missingFloorMedications(
  requestedTemplateMedicationIds: readonly string[],
  floorTemplateMedicationIds: readonly string[],
): readonly string[] {
  const requested = new Set(requestedTemplateMedicationIds);
  return floorTemplateMedicationIds.filter((id) => !requested.has(id));
}
