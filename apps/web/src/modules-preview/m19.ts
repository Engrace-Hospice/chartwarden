// modules-preview fixtures for M19 On-Call Triage. Typed against the module's own wire shapes so a drifted field fails
// the typecheck instead of rendering blank. Every name and id is invented.
import type {
  CurrentOnCallView,
  TriageProtocolView,
  VendorBindingView,
} from "../modules/19-oncall/oncall-api";
import { oncallScreens } from "../modules/19-oncall/screens";
import type { Fixtures } from "./mock-client";
import type { ModulePreview } from "./types";

const NOW = Date.now();
const iso = (days: number): string => new Date(NOW + days * 864e5).toISOString();
const day = (days: number): string => iso(days).slice(0, 10);

const protocols: TriageProtocolView[] = [
  ["pr1", "pain_crisis", "Pain crisis", "22253000", true, "tier_1_rn_supervisor"],
  ["pr2", "dyspnea", "Shortness of breath", "267036007", true, "tier_2_clinical_manager"],
  ["pr3", "fall_with_injury", "Fall with injury", "1912002", false, null],
].map(([id, key, label, snomed, mandatory, tier]) => ({
  id: id as string,
  organizationId: null,
  key: key as string,
  chiefComplaintLabel: label as string,
  snomedCode: snomed as string,
  disciplineRequired: "rn",
  isSystemLocked: true,
  requiresMandatoryEscalation: mandatory as boolean,
  mandatoryEscalationTier: tier as TriageProtocolView["mandatoryEscalationTier"],
  version: "1.2.0",
  effectiveFrom: iso(-90),
  effectiveTo: null,
  sortOrder: 1,
  questions: [
    {
      id: `${id}-q1`,
      questionOrder: 1,
      prompt: "How would the patient rate the pain right now, from 0 to 10?",
      answerType: "scale_0_10",
      answerEnumValues: null,
      required: true,
      isRedFlagQuestion: false,
      redFlagMatch: null,
      isSystemLocked: true,
    },
  ],
}));

const vendors: VendorBindingView[] = [
  ["v1", "Northwind After-Hours", "northwind", true, true, day(200)],
  ["v2", "Lakeside Triage Line", "lakeside", true, false, null],
].map(([id, name, adapterKey, rn, baa, expires]) => ({
  id: id as string,
  mdmVendorId: `mdm-${id}`,
  name: name as string,
  adapterKey: adapterKey as string,
  rnCoverageAttested: rn as boolean,
  baaInEffect: baa as boolean,
  baaExpiresOn: expires as string | null,
  minimizationProfile: "minimum_necessary",
  adapterRegistered: true,
}));

const current: CurrentOnCallView = {
  asOf: iso(0),
  perProviderEntity: [{ providerEntityId: "pe-1", actors: [], rnCoverageGap: false }],
};

const fixtures: Fixtures = {
  "/api/v1/triage-protocols": { data: protocols, next_cursor: null, has_more: false },
  "/api/v1/oncall/external-vendors": vendors,
  "/api/v1/oncall/current": current,
};

export const preview19: ModulePreview = {
  screens: oncallScreens,
  fixtures,
  start: "/triage/protocols",
  extraPermissions: [],
};
