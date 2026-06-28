// @wardenx/cost-report — Worksheet S-3 (Statistical Data) TypeBox schema (CMS-1984-14, §4.2 / §1.1).
// Mirrors the §4.2 representative schema EXACTLY: Part I patient days by program × level of care, Part II
// paid hours / salary / fringe by discipline (driven by the Gusto wage import or manual entry), Part III
// visits by discipline (from the M8 `EncounterStatisticsProvider` aggregate), and Part IV bereavement
// contacts. Hours are fractional (`Type.Number`); salary/fringe are INTEGER CENTS; days/visits/counts are
// integers. No PHI — aggregate statistics only (D18).
//
// PURE DOMAIN: TypeBox only — no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`.
import { Type, type Static } from "@sinclair/typebox";

const ProgramDays = Type.Object({
  rhc: Type.Integer(),
  chc: Type.Integer(),
  irc: Type.Integer(),
  gip: Type.Integer(),
  total: Type.Integer(),
});

/** Worksheet S-3 — statistical data (Parts I–IV). Field set is verbatim from spec §4.2. */
export const WorksheetS3 = Type.Object({
  partI_patientDays: Type.Object({
    medicare: ProgramDays,
    medicaid: ProgramDays,
    other: ProgramDays,
    grandTotal: Type.Integer(),
  }),
  partII_wages: Type.Object({
    rnPaidHours: Type.Number(),
    rnSalary: Type.Integer(),
    rnFringe: Type.Integer(),
    lpnPaidHours: Type.Number(),
    lpnSalary: Type.Integer(),
    lpnFringe: Type.Integer(),
    aidePaidHours: Type.Number(),
    aideSalary: Type.Integer(),
    aideFringe: Type.Integer(),
    mswPaidHours: Type.Number(),
    mswSalary: Type.Integer(),
    mswFringe: Type.Integer(),
    chaplainPaidHours: Type.Number(),
    chaplainSalary: Type.Integer(),
    chaplainFringe: Type.Integer(),
    therapyPaidHours: Type.Number(),
    therapySalary: Type.Integer(),
    therapyFringe: Type.Integer(),
    administrativePaidHours: Type.Number(),
    administrativeSalary: Type.Integer(),
    administrativeFringe: Type.Integer(),
  }),
  partIII_visits: Type.Object({
    rnVisits: Type.Integer(),
    lpnVisits: Type.Integer(),
    aideVisits: Type.Integer(),
    mswVisits: Type.Integer(),
    chaplainVisits: Type.Integer(),
    therapyVisits: Type.Integer(),
    volunteerVisits: Type.Integer(),
  }),
  partIV_bereavementContacts: Type.Object({
    contactsCount: Type.Integer(),
    visitsCount: Type.Integer(),
  }),
});

export type WorksheetS3Data = Static<typeof WorksheetS3>;
