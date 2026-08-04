// @wardenx/cost-report — Worksheet C (Calculation of Per Diem Cost) TypeBox schema (Form CMS-1984-14,
// Pub 15-2 §4330). C is the hospice cost report's terminal computed worksheet: for each level of care
// (CHC / RHC / IRC / GIP) it takes the fully-allocated cost from Worksheet B (col. 18, lines 50–53),
// divides by the total *unduplicated* days from Worksheet S-1 (col. 4) to get the average cost per diem
// (col. 3), then multiplies by the program (Medicare XVIII / Medicaid XIX) unduplicated days from S-1 to
// get the program cost (cols. 1 / 2). Columns: 1 = Medicare, 2 = Medicaid, 3 = Total. There is no
// settlement worksheet beyond this on the hospice form (D8). Money is INTEGER CENTS; per-diem is an exact
// decimal string; no PHI — aggregate cost/day only (D18).
//
// CMS-CERT: certified against the form + Ch.43 §4330 (audit/M27_CMS_LINE_GEOMETRY_CERTIFICATION.md).
// PURE DOMAIN: TypeBox only — no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`.
import { type Static, Type } from "@sinclair/typebox";

/** One level of care's per-diem block (§4330 lines per LOC: total cost / total days / per diem / program cost). */
const PerDiemLevel = Type.Object({
  /** Total cost from Worksheet B, col. 18 (CHC=line 50, RHC=51, IRC=52, GIP=53). */
  totalCostCents: Type.Integer({ default: 0 }),
  /** Total unduplicated days from Worksheet S-1, col. 4. */
  totalDays: Type.Integer({ default: 0 }),
  /** Average cost per diem = totalCostCents ÷ totalDays (exact decimal string for audit; no float). */
  averageCostPerDiem: Type.String({ default: "0" }),
  /** Medicare (XVIII) unduplicated program days (S-1 col. 1) + the resulting program cost (per diem × days). */
  medicareDays: Type.Integer({ default: 0 }),
  medicareCostCents: Type.Integer({ default: 0 }),
  /** Medicaid (XIX) unduplicated program days (S-1 col. 2) + the resulting program cost. */
  medicaidDays: Type.Integer({ default: 0 }),
  medicaidCostCents: Type.Integer({ default: 0 }),
});

/** Worksheet C — calculation of per diem cost by level of care. */
export const WorksheetC = Type.Object(
  {
    continuousHomeCare: PerDiemLevel, // CHC — §4330 lines 1–5
    routineHomeCare: PerDiemLevel, // RHC — lines 6–10
    inpatientRespiteCare: PerDiemLevel, // IRC — lines 11–15
    generalInpatientCare: PerDiemLevel, // GIP — lines 16–20
    /** Total hospice care (lines 21–23): Σ LOC costs, total days (S-1 line 34), and the blended per diem. */
    totalHospiceCostCents: Type.Integer({ default: 0 }),
    totalHospiceDays: Type.Integer({ default: 0 }),
    totalAverageCostPerDiem: Type.String({ default: "0" }),
    /** Σ of the four LOC totalCostCents equals Worksheet B col. 18 fully-allocated total (the A→B→C tie). */
    tiesToWorksheetBTotal: Type.Boolean({ default: false }),
  },
  { additionalProperties: false },
);

export type WorksheetCData = Static<typeof WorksheetC>;
