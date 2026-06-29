// @wardenx/cost-report — M27 worksheet-code → TypeBox-schema RESOLVER (§4.2, D3). All 21 CMS-1984-14
// worksheets share one `cost_report_worksheet` table discriminated by `worksheet_code`, with a
// TypeBox-typed `data` jsonb per code; the per-worksheet schemas live one file per code under
// `packages/cost-report/src/worksheets/`. This file is the central REGISTRY + resolver the service layer
// uses to (a) validate a `data` write against the schema for its code and (b) materialize the empty
// validated default on first lazy read of a worksheet (§2.2 worksheet lifecycle).
//
// STAGE-2: every code now resolves to its CONCRETE per-code schema (the §4.2 `WorksheetA` / `WorksheetS3`
// are mirrored exactly; the remaining nineteen follow the same INTEGER-CENTS pattern per the worksheet's
// CMS role). `resolveWorksheetSchema` / `emptyWorksheetData` are unchanged from Stage-1 — only the registry
// bindings were swapped. The registry stays exported so a later fiscal-year-aware resolver (§4.2:
// `a-2027.ts`) can layer over this map per the cost report's fiscal year.
//
// PURE DOMAIN: TypeBox only — no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`. No
// PHI — worksheet data is aggregate financial/statistical only (D18).
import { type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { WORKSHEET_CODES, type WorksheetCode } from "../contracts";
import { WorksheetS } from "./s";
import { WorksheetS1 } from "./s-1";
import { WorksheetS2 } from "./s-2";
import { WorksheetA } from "./a";
import { WorksheetA1 } from "./a-1";
import { WorksheetA2 } from "./a-2";
import { WorksheetA3 } from "./a-3";
import { WorksheetA4 } from "./a-4";
import { WorksheetA6 } from "./a-6";
import { WorksheetA8 } from "./a-8";
import { WorksheetA81 } from "./a-8-1";
import { WorksheetB } from "./b";
import { WorksheetB1 } from "./b-1";
import { WorksheetC } from "./c";
import { WorksheetF } from "./f";
import { WorksheetF1 } from "./f-1";
import { WorksheetF2 } from "./f-2";

/**
 * The worksheet-code → schema registry — the single source of truth the resolver delegates to. Keyed by
 * EVERY one of the 21 codes (`WORKSHEET_CODES`) so the `Record<WorksheetCode, TSchema>` is exhaustive and
 * the resolver is total. Each value is the concrete per-code schema. A fiscal-year-aware resolver can
 * extend/override this map; the binding is exported for that purpose.
 */
export const WORKSHEET_SCHEMAS: Record<WorksheetCode, TSchema> = {
  S: WorksheetS,
  "S-1": WorksheetS1,
  "S-2": WorksheetS2,
  A: WorksheetA,
  "A-1": WorksheetA1,
  "A-2": WorksheetA2,
  "A-3": WorksheetA3,
  "A-4": WorksheetA4,
  "A-6": WorksheetA6,
  "A-8": WorksheetA8,
  "A-8-1": WorksheetA81,
  B: WorksheetB,
  "B-1": WorksheetB1,
  C: WorksheetC,
  F: WorksheetF,
  "F-1": WorksheetF1,
  "F-2": WorksheetF2,
};

/**
 * Defensive boot assertion that the registry is exhaustive over the 21 codes — if a code is ever added to
 * `WORKSHEET_CODES` without a registered schema, this throws at module load rather than yielding an
 * `undefined` schema at resolve time. Kept as a pure check (no side effects beyond the throw).
 */
for (const code of WORKSHEET_CODES) {
  if (!(code in WORKSHEET_SCHEMAS)) {
    throw new Error(`WORKSHEET_SCHEMAS missing a schema for worksheet code "${code}"`);
  }
}

/**
 * Resolve the TypeBox schema for a worksheet code. Total over the 21-code union (the registry is
 * exhaustive). The service layer validates a `cost_report_worksheet.data` write against this schema and
 * refuses the write with a structured error on validation failure (§2.3).
 */
export function resolveWorksheetSchema(code: WorksheetCode): TSchema {
  return WORKSHEET_SCHEMAS[code];
}

/**
 * The empty, schema-valid default `data` payload for a worksheet code — used on the first lazy read of a
 * worksheet that has no row yet (§2.2). Derived from the registered schema via TypeBox `Value.Create`, so
 * the field-level `default`s declared on each concrete schema produce the correct populated default.
 */
export function emptyWorksheetData(code: WorksheetCode): unknown {
  return Value.Create(resolveWorksheetSchema(code));
}
