// @wardenx/fhir — FHIR R4 (4.0.1) wire types (M28-T04).
//
// A PRAGMATIC subset of the FHIR R4 resource/datatype shapes — only the elements the Phase-1 read-only
// projections (§4.5, §4.11) actually emit. These are the OUTPUT shapes of the mappers; the gateway
// persists no clinical resource (§1.2), so every one of these is composed at read time from an owner
// module's reader seam and handed straight to the wire.
//
// R5 / R6 shapes are Phase-3 compile-shells (D1); this file is `4.0.1` only. The mappers pin
// `meta.profile` to the matching US Core 6.0 StructureDefinition so a consumer's conformance test sees
// the profile it expects.

// ── Primitive-ish datatypes ───────────────────────────────────────────────────────────────────────────

/** A `Coding` — a single code drawn from a code system (LOINC, SNOMED, RxNorm, the HL7 ValueSets). */
export interface FhirCoding {
  system?: string;
  code?: string;
  display?: string;
  version?: string;
}

/** A `CodeableConcept` — one or more codings plus an optional free-text fallback. */
export interface FhirCodeableConcept {
  coding?: FhirCoding[];
  text?: string;
}

/** An `Identifier` — a business identifier (MRN, NPI, NDC) namespaced by `system` (D9). */
export interface FhirIdentifier {
  use?: "usual" | "official" | "temp" | "secondary" | "old";
  system?: string;
  value?: string;
  type?: FhirCodeableConcept;
}

/** A `Reference` — a typed pointer to another resource, `ResourceType/id`. */
export interface FhirReference {
  reference?: string;
  type?: string;
  display?: string;
  identifier?: FhirIdentifier;
}

/** A `Period` — a start/end instant pair (ISO 8601). */
export interface FhirPeriod {
  start?: string;
  end?: string;
}

/** A `Quantity` — a numeric measurement with UCUM unit (`system: http://unitsofmeasure.org`). */
export interface FhirQuantity {
  value?: number;
  unit?: string;
  system?: string;
  code?: string;
  comparator?: "<" | "<=" | ">=" | ">";
}

/** A `Range` — a low/high `Quantity` pair (used by `Observation.referenceRange` on some profiles). */
export interface FhirRange {
  low?: FhirQuantity;
  high?: FhirQuantity;
}

/** An `Annotation` — a dated free-text note (`Observation.note`, the SUD-redaction banner in §4.11.3). */
export interface FhirAnnotation {
  text: string;
  time?: string;
  authorString?: string;
}

/** A `HumanName` — the `Patient.name` element (US Core mandates `family` + `given`). */
export interface FhirHumanName {
  use?: "usual" | "official" | "temp" | "nickname" | "anonymous" | "old" | "maiden";
  text?: string;
  family?: string;
  given?: string[];
  prefix?: string[];
  suffix?: string[];
}

/** A `ContactPoint` — `Patient.telecom` (phone / email). */
export interface FhirContactPoint {
  system?: "phone" | "fax" | "email" | "pager" | "url" | "sms" | "other";
  value?: string;
  use?: "home" | "work" | "temp" | "old" | "mobile";
}

/** An `Address` — `Patient.address`. */
export interface FhirAddress {
  use?: "home" | "work" | "temp" | "old" | "billing";
  type?: "postal" | "physical" | "both";
  line?: string[];
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

/** A resource `meta` — `profile` pins the US Core StructureDefinition; `security` carries the D20
 *  `R` (restricted) label and the internal `R-SUD` marker the redaction applier keys on. */
export interface FhirMeta {
  versionId?: string;
  lastUpdated?: string;
  profile?: string[];
  security?: FhirCoding[];
}

/** An arbitrary FHIR extension (used by the Practitioner NPPES extensions in §4.12, a later task). */
export interface FhirExtension {
  url: string;
  valueString?: string;
  valueDateTime?: string;
  valueBoolean?: boolean;
  valueCode?: string;
}

// ── Resources ─────────────────────────────────────────────────────────────────────────────────────────

/** Common resource preamble shared by every projection. */
interface FhirResourceBase {
  id?: string;
  meta?: FhirMeta;
}

/** `Patient` — us-core-patient (M5). */
export interface Patient extends FhirResourceBase {
  resourceType: "Patient";
  identifier?: FhirIdentifier[];
  active?: boolean;
  name?: FhirHumanName[];
  telecom?: FhirContactPoint[];
  gender?: "male" | "female" | "other" | "unknown";
  birthDate?: string;
  deceasedBoolean?: boolean;
  deceasedDateTime?: string;
  address?: FhirAddress[];
}

/** `Encounter` — us-core-encounter (M6 / M8). */
export interface Encounter extends FhirResourceBase {
  resourceType: "Encounter";
  identifier?: FhirIdentifier[];
  status: "planned" | "arrived" | "triaged" | "in-progress" | "onleave" | "finished" | "cancelled" | "entered-in-error" | "unknown";
  class: FhirCoding;
  type?: FhirCodeableConcept[];
  subject: FhirReference;
  participant?: { individual?: FhirReference; type?: FhirCodeableConcept[] }[];
  period?: FhirPeriod;
  reasonCode?: FhirCodeableConcept[];
}

/** `Condition` — us-core-condition-problems-health-concerns (M6 diagnoses). */
export interface Condition extends FhirResourceBase {
  resourceType: "Condition";
  clinicalStatus?: FhirCodeableConcept;
  verificationStatus?: FhirCodeableConcept;
  category?: FhirCodeableConcept[];
  code?: FhirCodeableConcept;
  subject: FhirReference;
  onsetDateTime?: string;
  recordedDate?: string;
}

/** `Goal` — us-core-goal (M7 care-plan goals). */
export interface Goal extends FhirResourceBase {
  resourceType: "Goal";
  lifecycleStatus: "proposed" | "planned" | "accepted" | "active" | "on-hold" | "completed" | "cancelled" | "entered-in-error" | "rejected";
  achievementStatus?: FhirCodeableConcept;
  description: FhirCodeableConcept;
  subject: FhirReference;
  target?: { dueDate?: string; measure?: FhirCodeableConcept }[];
}

/** `CarePlan` — us-core-careplan (M7). */
export interface CarePlan extends FhirResourceBase {
  resourceType: "CarePlan";
  status: "draft" | "active" | "on-hold" | "revoked" | "completed" | "entered-in-error" | "unknown";
  intent: "proposal" | "plan" | "order" | "option";
  category?: FhirCodeableConcept[];
  title?: string;
  description?: string;
  subject: FhirReference;
  period?: FhirPeriod;
  addresses?: FhirReference[];
  goal?: FhirReference[];
}

/** A `Dosage` — `MedicationRequest.dosageInstruction` (US Core requires the free-text form). */
export interface FhirDosage {
  text?: string;
  route?: FhirCodeableConcept;
  timing?: { code?: FhirCodeableConcept };
  doseAndRate?: { doseQuantity?: FhirQuantity }[];
}

/** `MedicationRequest` — us-core-medicationrequest (M12). */
export interface MedicationRequest extends FhirResourceBase {
  resourceType: "MedicationRequest";
  status: "active" | "on-hold" | "cancelled" | "completed" | "entered-in-error" | "stopped" | "draft" | "unknown";
  intent: "proposal" | "plan" | "order" | "original-order" | "reflex-order" | "filler-order" | "instance-order" | "option";
  medicationCodeableConcept?: FhirCodeableConcept;
  medicationReference?: FhirReference;
  subject: FhirReference;
  authoredOn?: string;
  requester?: FhirReference;
  reasonCode?: FhirCodeableConcept[];
  dosageInstruction?: FhirDosage[];
}

/** `MedicationStatement` — the patient-reported / reconciled medication history (M12). */
export interface MedicationStatement extends FhirResourceBase {
  resourceType: "MedicationStatement";
  status: "active" | "completed" | "entered-in-error" | "intended" | "stopped" | "on-hold" | "unknown" | "not-taken";
  medicationCodeableConcept?: FhirCodeableConcept;
  medicationReference?: FhirReference;
  subject: FhirReference;
  effectiveDateTime?: string;
  effectivePeriod?: FhirPeriod;
  dateAsserted?: string;
  dosage?: FhirDosage[];
}

/** `Observation` — us-core-observation (a per-value lab result, §4.11). */
export interface Observation extends FhirResourceBase {
  resourceType: "Observation";
  status: "registered" | "preliminary" | "final" | "amended" | "corrected" | "cancelled" | "entered-in-error" | "unknown";
  category?: FhirCodeableConcept[];
  code: FhirCodeableConcept;
  subject?: FhirReference;
  effectiveDateTime?: string;
  valueQuantity?: FhirQuantity;
  valueString?: string;
  dataAbsentReason?: FhirCodeableConcept;
  interpretation?: FhirCodeableConcept[];
  note?: FhirAnnotation[];
  referenceRange?: { low?: FhirQuantity; high?: FhirQuantity; text?: string }[];
}

/** `DiagnosticReport` — us-core-diagnosticreport-lab (§4.11, composed from M11 + M29 + M40). */
export interface DiagnosticReport extends FhirResourceBase {
  resourceType: "DiagnosticReport";
  status: "registered" | "partial" | "preliminary" | "final" | "amended" | "corrected" | "appended" | "cancelled" | "entered-in-error" | "unknown";
  category?: FhirCodeableConcept[];
  code: FhirCodeableConcept;
  subject: FhirReference;
  effectivePeriod?: FhirPeriod;
  effectiveDateTime?: string;
  issued?: string;
  performer?: FhirReference[];
  result?: FhirReference[];
  conclusion?: string;
  contained?: Observation[];
}

/** An `OperationOutcome.issue` — one diagnostic entry (severity + code + human detail). */
export interface OperationOutcomeIssue {
  severity: "fatal" | "error" | "warning" | "information";
  /** The FHIR issue-type code — `suppressed` for the W-FHIR-03 consent-filter advisory, `not-supported`
   *  for the W-FHIR-07 forward-seam 404, `throttled` for the D16 429, `invalid` for search errors. */
  code: string;
  details?: FhirCodeableConcept;
  diagnostics?: string;
  expression?: string[];
}

/** `OperationOutcome` — the FHIR error/advisory envelope. M28 emits it for the W-FHIR-03 SUD-redaction
 *  warning folded into the response Bundle, the W-FHIR-07 not-supported error, and the throttle /
 *  validation errors. Deliberately NOT part of `FhirProjectedResource`: it is an out-of-band advisory,
 *  never a projected clinical entity, so the egress consent gate can never mistake it for one. */
export interface OperationOutcome extends FhirResourceBase {
  resourceType: "OperationOutcome";
  issue: OperationOutcomeIssue[];
}

/** The read-only union of resource types the Phase-1 gateway PROJECTS (D1). Not the same as the inbound
 *  or forward-seam sets — those are tracked in `@wardenx/types`. */
export type FhirProjectedResource =
  | Patient
  | Encounter
  | Condition
  | Goal
  | CarePlan
  | MedicationRequest
  | MedicationStatement
  | DiagnosticReport
  | Observation;
