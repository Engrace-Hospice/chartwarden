// @chartwarden/billing — eligibility schemas: route #22 `POST /eligibility:check` (force a 270/271 round-trip)
// and route #23 `GET /eligibility` (per-patient eligibility-check history) — §4.1 / §4.2.
//
// The MBI is unlocked from M5 only in-memory at HETS-270 build time and NEVER persisted or projected
// (D13 / §3.6); no MBI digit appears on any field here.
import { type Static, Type } from "@sinclair/typebox";
import {
  CursorPageQuery,
  EligibilityOutcomeApi,
  IsoDateSchema,
  IsoDateTimeSchema,
  PageOf,
  Uuid,
} from "./common";

// ── route #22: force a fresh check ──────────────────────────────────────────────────────────────────────
export const EligibilityCheckRequest = Type.Object({
  patientId: Uuid,
  asOfServiceDate: IsoDateSchema,
  /** If false and a fresh result exists, returns the cached row. */
  force: Type.Boolean({ default: false }),
});
export type EligibilityCheckRequest = Static<typeof EligibilityCheckRequest>;

export const EligibilityCheckDetail = Type.Object({
  partAActive: Type.Boolean(),
  planEffective: Type.Optional(IsoDateSchema),
  planEnd: Type.Optional(IsoDateSchema),
  otherCoverages: Type.Array(Type.String()),
});
export type EligibilityCheckDetail = Static<typeof EligibilityCheckDetail>;

export const EligibilityCheckResponse = Type.Object({
  checkId: Uuid,
  outcome: EligibilityOutcomeApi,
  checkedAt: IsoDateTimeSchema,
  staleAt: IsoDateTimeSchema,
  details: EligibilityCheckDetail,
});
export type EligibilityCheckResponse = Static<typeof EligibilityCheckResponse>;

// Errors (per §4.2):
//   503 HETS_UNAVAILABLE — Tier-3; cached row returned with outcome='hets_error' + staleAt=now()
//   422 MBI_MISSING      — the patient_payer row has no MBI on file

// ── route #23: per-patient eligibility-check history ────────────────────────────────────────────────────
export const EligibilityListQuery = Type.Composite([
  CursorPageQuery,
  Type.Object({
    patientId: Uuid,
    asOfFrom: Type.Optional(IsoDateSchema),
    asOfTo: Type.Optional(IsoDateSchema),
  }),
]);
export type EligibilityListQuery = Static<typeof EligibilityListQuery>;

export const EligibilityCheckView = Type.Object({
  checkId: Uuid,
  patientId: Uuid,
  asOfServiceDate: IsoDateSchema,
  outcome: EligibilityOutcomeApi,
  checkedAt: IsoDateTimeSchema,
  staleAt: IsoDateTimeSchema,
});
export type EligibilityCheckView = Static<typeof EligibilityCheckView>;

export const EligibilityListResponse = PageOf(EligibilityCheckView);
export type EligibilityListResponse = Static<typeof EligibilityListResponse>;
