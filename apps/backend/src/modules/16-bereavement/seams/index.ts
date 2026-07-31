// apps/backend/src/modules/16-bereavement/seams — the barrel over the seams M16 CONSUMES (M16-T03).
//
// M16's PUBLISHED §4.6 seams (`BereavementPlanProvider`, `BereavementOutreachProvider`,
// `BereavementRiskFactorsProvider`, `BereavementAssignmentReader`, `BereavedPortalScopeProvider`,
// `BereavementComplianceProvider`, `BereavementRiskTierProvider`) are M16-T05 and will register here over
// their boot deny-stubs, alongside these consumed-side resolvers — the M15 `seams/` layout verbatim.
export {
  getAdmissionStatusReader,
  getDeathDischargeReader,
  getMswRiskFactorReader,
  getPatientReader,
  getScaleSeriesProvider,
} from "./consumed";
