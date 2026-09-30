// Dev-only visual harness (mock ApiClient, no backend) for the HOPE workspace. Not a build entry: vite.config.ts builds index.html only. Open via `vite` at /hope-preview.html.
import "@fontsource-variable/inter";
import "./index.css";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { HopeAssessmentDetail } from "./modules/10-hope/hope-assessment-detail";

document.documentElement.classList.toggle("dark", new URLSearchParams(location.search).has("dark"));
const cn = [
  { valueCode: "0", label: "Not checked (No)", sortOrder: 1 },
  { valueCode: "1", label: "Checked (Yes)", sortOrder: 2 },
];
const it = (o: Record<string, unknown>) => ({
  label: "",
  section: "A",
  group: null,
  kind: "assessment",
  active: true,
  state: "unanswered",
  value: null,
  source: null,
  answeredAt: null,
  answeredByMembershipId: null,
  applicability: "applicable",
  skipReason: null,
  options: [],
  ...o,
});
const A = [
  it({
    itemCode: "A0100A",
    label: "Facility National Provider Identifier (NPI)",
    value: "1872347803",
    source: "derived",
    state: "answered",
  }),
  it({
    itemCode: "A0100B",
    label: "Facility CMS Certification Number (CCN)",
    value: "381688",
    source: "derived",
    state: "answered",
  }),
  it({
    itemCode: "A0215",
    label: "Site of service at admission",
    value: "01",
    state: "answered",
    options: [
      { valueCode: "01", label: "Patient's Home/Residence", sortOrder: 1 },
      { valueCode: "02", label: "Hospice inpatient facility", sortOrder: 2 },
      { valueCode: "03", label: "Hospital", sortOrder: 3 },
    ],
  }),
  it({
    itemCode: "A0220",
    label: "Admission date",
    value: "2026-09-21",
    cmsItemTypeCode: "date",
    source: "admission_prefill",
    state: "answered",
  }),
  it({
    itemCode: "A0250",
    label: "Reason for record",
    value: "01",
    source: "derived",
    state: "answered",
    options: [{ valueCode: "01", label: "Admission (ADM)", sortOrder: 1 }],
  }),
  it({
    itemCode: "A0500A",
    label: "First name",
    value: "Henry",
    source: "patient_prefill",
    state: "answered",
    cmsItemTypeCode: "Text",
    options: [{ valueCode: "Text", label: "First name", sortOrder: 1 }],
  }),
  it({
    itemCode: "A0500B",
    label: "Middle initial",
    cmsItemTypeCode: "Text",
    maxLength: 1,
    options: [{ valueCode: "Text", label: "Middle", sortOrder: 1 }],
  }),
  it({
    itemCode: "A0500C",
    label: "Last name",
    value: "Nakamura",
    source: "patient_prefill",
    state: "answered",
    cmsItemTypeCode: "Text",
    options: [{ valueCode: "Text", label: "Last", sortOrder: 1 }],
  }),
  it({
    itemCode: "A0500D",
    label: "Suffix",
    cmsItemTypeCode: "Text",
    options: [{ valueCode: "Text", label: "Suffix", sortOrder: 1 }],
  }),
  it({
    itemCode: "A0900",
    label: "Date of birth",
    value: "1936-01-18",
    cmsItemTypeCode: "date",
    source: "patient_prefill",
    state: "answered",
  }),
  it({
    itemCode: "A0800",
    label: "Gender",
    value: "1",
    source: "patient_prefill",
    state: "answered",
    options: [
      { valueCode: "1", label: "Male", sortOrder: 1 },
      { valueCode: "2", label: "Female", sortOrder: 2 },
    ],
  }),
  it({
    itemCode: "A1005A",
    label: "No, not of Hispanic, Latino/a, or Spanish origin",
    value: "1",
    state: "answered",
    options: cn,
  }),
  it({
    itemCode: "A1005B",
    label: "Yes, Mexican, Mexican American, Chicano/a",
    value: "0",
    state: "answered",
    options: cn,
  }),
  it({ itemCode: "A1005C", label: "Yes, Puerto Rican", value: "0", options: cn }),
  it({ itemCode: "A1005D", label: "Yes, Cuban", value: "0", options: cn }),
  it({
    itemCode: "A1005E",
    label: "Yes, another Hispanic, Latino/a, or Spanish origin",
    value: "0",
    options: cn,
  }),
  it({ itemCode: "A1005X", label: "Patient unable to respond", value: "0", options: cn }),
];
const opt = (pairs: [string, string][]) =>
  pairs.map(([v, l], i) => ({ valueCode: v, label: l, sortOrder: i }));
const J = [
  it({
    section: "J",
    itemCode: "J0050",
    label: "Death is imminent",
    value: "0",
    state: "answered",
    options: opt([
      ["0", "No"],
      ["1", "Yes"],
    ]),
  }),
  it({
    section: "J",
    itemCode: "J0900A",
    label: "Pain screening completed",
    options: opt([
      ["0", "No"],
      ["1", "Yes"],
    ]),
  }),
  it({
    section: "J",
    itemCode: "J0900C",
    label: "Pain severity",
    options: opt([
      ["0", "None"],
      ["1", "Mild"],
      ["2", "Moderate"],
      ["3", "Severe"],
      ["9", "Pain not rated"],
    ]),
  }),
  it({
    section: "J",
    itemCode: "J2030A",
    label: "Shortness of breath screening completed",
    value: "1",
    state: "answered",
    options: opt([
      ["0", "No"],
      ["1", "Yes"],
    ]),
  }),
  it({
    section: "J",
    itemCode: "J2040A",
    label: "Treatment for shortness of breath initiated",
    applicability: "pending",
    skipReason: { ruleId: "r1", cmsRuleId: "J2040-1", dependsOn: ["J2030C"] },
  }),
  it({
    section: "J",
    itemCode: "J2051A",
    label: "Symptom impact — pain",
    options: opt([
      ["0", "Not at all"],
      ["1", "Slight"],
      ["2", "Moderate"],
      ["3", "Severe"],
      ["9", "Not assessed"],
    ]),
  }),
];
const workspace = {
  assessment: {
    id: "hope-1",
    status: "draft",
    rfaKind: "01_admission",
    targetDate: "2026-09-24",
    isc: "HA",
    specVersionId: "s",
    specVersion: "1.00.1",
    version: 4,
  },
  sections: [
    { code: "A", label: "Administrative", items: A },
    {
      code: "F",
      label: "Preferences",
      items: [
        it({
          section: "F",
          itemCode: "F2000A",
          label: "Was CPR discussed?",
          options: opt([
            ["0", "No"],
            ["1", "Yes, discussion occurred"],
          ]),
        }),
      ],
    },
    {
      code: "I",
      label: "Diagnoses",
      items: [
        it({
          section: "I",
          itemCode: "I0010",
          label: "Principal diagnosis",
          value: "01",
          state: "answered",
          options: opt([
            ["01", "Cancer"],
            ["02", "Dementia"],
            ["03", "Heart disease"],
          ]),
        }),
      ],
    },
    { code: "J", label: "Health Conditions", items: J },
    {
      code: "M",
      label: "Skin",
      items: [
        it({
          section: "M",
          itemCode: "M1190",
          label: "Skin conditions present",
          options: opt([
            ["0", "No"],
            ["1", "Yes"],
          ]),
        }),
      ],
    },
    {
      code: "N",
      label: "Medications",
      items: [
        it({
          section: "N",
          itemCode: "N0500A",
          label: "Scheduled opioid initiated",
          options: opt([
            ["0", "No"],
            ["1", "Yes"],
          ]),
        }),
      ],
    },
  ],
  progress: {
    active: 30,
    applicable: 29,
    notApplicable: 0,
    pending: 1,
    answered: 12,
    skipped: 0,
    unanswered: 17,
  },
  huv: null,
};
const review = {
  assessmentId: "hope-1",
  version: 4,
  specVersion: "1.00.1",
  isc: "HA",
  status: "draft",
  signedAt: null,
  signedByMembershipId: null,
  z0350: null,
  z0500b: null,
  sections: [
    {
      code: "A",
      active: 17,
      applicable: 17,
      answered: 15,
      skipped: 0,
      pending: 0,
      unanswered: 2,
      errors: 2,
      warnings: 0,
      state: "needs_attention",
    },
    {
      code: "F",
      active: 1,
      applicable: 1,
      answered: 1,
      skipped: 0,
      pending: 0,
      unanswered: 0,
      errors: 0,
      warnings: 0,
      state: "complete",
    },
    {
      code: "I",
      active: 1,
      applicable: 1,
      answered: 1,
      skipped: 0,
      pending: 0,
      unanswered: 0,
      errors: 0,
      warnings: 0,
      state: "complete",
    },
    {
      code: "J",
      active: 8,
      applicable: 8,
      answered: 3,
      skipped: 0,
      pending: 1,
      unanswered: 5,
      errors: 0,
      warnings: 0,
      state: "needs_attention",
    },
    {
      code: "M",
      active: 1,
      applicable: 1,
      answered: 0,
      skipped: 0,
      pending: 0,
      unanswered: 1,
      errors: 0,
      warnings: 0,
      state: "needs_attention",
    },
    {
      code: "N",
      active: 1,
      applicable: 1,
      answered: 0,
      skipped: 0,
      pending: 0,
      unanswered: 1,
      errors: 0,
      warnings: 0,
      state: "needs_attention",
    },
  ],
  progress: { active: 30, applicable: 29, answered: 12, skipped: 0, pending: 1, unanswered: 17 },
  validation: {
    errorCount: 2,
    warningCount: 0,
    hasBlockingErrors: true,
    findings: [
      {
        ruleId: "A0500B-req",
        severity: "error",
        section: "A",
        itemCode: "A1005C",
        message: "Ethnicity response required",
      },
      {
        ruleId: "A0900-x",
        severity: "error",
        section: "A",
        itemCode: "A0500D",
        message: "Suffix must be blank or valid",
      },
    ],
  },
  sfv: { required: null },
  readiness: {
    readyToSign: false,
    blockers: [
      { code: "SECTION_INCOMPLETE", section: "J", message: "Section J has unanswered items" },
    ],
  },
};
const assessment = {
  id: "hope-1",
  patientId: "p1",
  rfaKind: "01_admission",
  status: "draft",
  targetDate: "2026-09-24",
  authorDiscipline: "RN",
  j2051MaxSeverity: null,
  j2051TriggerFired: false,
  wasLate: false,
  signedAt: null,
  signedBy: null,
  correctsAssessmentId: null,
  supersededByAssessmentId: null,
  snapshot: null,
  version: 4,
};
const routes: Record<string, unknown> = {
  "/api/v1/hope/assessments/{id}": assessment,
  "/api/v1/hope/assessments/{id}/workspace": workspace,
  "/api/v1/hope/assessments/{id}/review": review,
  "/api/v1/patients/{patientId}/hope/assessments": { assessments: [] },
  "/api/v1/patients/{id}": {
    id: "p1",
    organizationId: "o",
    mrn: "MRN-88901325A7AC",
    firstName: "Henry",
    lastName: "Nakamura",
    dob: "1936-01-18",
    status: "prospective",
  },
  "/api/v1/patients/{id}/demographics": { sexAssignedAtBirth: "M" },
  "/api/v1/patients/{id}/identifiers": {
    identifiers: [{ kind: "mbi", value: null, last4: "5234" }],
  },
  "/api/v1/patients/{id}/addresses": {
    addresses: [
      {
        line1: "1234 Oak St",
        city: "Pendleton",
        state: "OR",
        postalCode: "97801",
        current: true,
        isPrimary: true,
      },
    ],
  },
};
const res = (data: unknown) =>
  Promise.resolve({ data, error: undefined, response: new Response() });
const client = {
  GET: (p: string) => res(routes[p]),
  PATCH: () => res({ version: 5 }),
  POST: () => res({}),
} as unknown as ApiClient;
createRoot(document.getElementById("root")!).render(
  <div style={{ height: "100vh", display: "flex" }}>
    <MemoryRouter initialEntries={["/hope/assessments/hope-1"]}>
      <ApiClientProvider client={client}>
        <Routes>
          <Route path="/hope/assessments/:id" element={<HopeAssessmentDetail />} />
        </Routes>
      </ApiClientProvider>
    </MemoryRouter>
  </div>,
);
