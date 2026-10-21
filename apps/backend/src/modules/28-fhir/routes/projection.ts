// apps/backend/src/modules/28-fhir/routes/projection.ts — the read-time FHIR projection (F-035, #95).
//
// M28 owns no clinical PHI (§1.2). Every resource served here is composed at request time from an OWNER
// module's data, reached through the M1 seam registry, shaped by a PURE mapper from `@chartwarden/fhir`, and
// then put through the D3 egress consent gate before a single byte reaches the wire. This file is that
// pipeline; it holds no data and no SQL.
//
// ── WHAT IS SERVED, AND WHY THE LIST IS SHORTER THAN THE CAPABILITY STATEMENT USED TO CLAIM ─────────
// The Phase-1 CapabilityStatement — served anonymously, before any authentication, which is exactly where
// a partner's conformance tooling looks first — declared `read` and `search-type` on TWELVE resource
// types plus `$export` and `$everything`. None of them worked: R4 returned an unconditional
// `404 not-found` and R5 an empty Bundle. A machine-readable conformance claim that is false is worse
// than an absent one, because it is the artefact a consumer builds against.
//
// `SERVED_RESOURCES` is now the single source of truth for BOTH the CapabilityStatement and the router,
// so the two cannot disagree, and it lists exactly what the registered seams can actually answer:
//
//   Patient                   read + search (`_id`, `identifier`)   — M5 PatientReader
//   Encounter                 search (`patient`)                    — M8 SignedEncountersReader
//   MedicationRequest         read + search (`patient`)             — M12 MedicationOrderProvider
//   MedicationAdministration  read + search (`patient`)             — M13 MedicationAdministrationProvider
//
// Encounter is search-only, and that is a truthful statement rather than an omission: M8 publishes
// `signedEncountersForPatientSince(org, patient, since)` and no read-by-id, so an instance read has no
// data path. Declaring `search-type` alone is precisely what `CapabilityStatement.rest.resource
// .interaction` exists to express. The eight resources no longer advertised each need a named
// producer-side read that does not exist yet (Condition and Coverage have no reader seam at all;
// CarePlan and Goal have a `CarePlanReader` whose methods are an encounter-element picker, an overdue
// check and two org rollups, none of which can load one plan by id).
//
// ── THE TWO PURPOSE-BUILT HANDSHAKES THIS DELIBERATELY DOES NOT USE ────────────────────────────────
// M12 publishes `asFhirMedicationRequest` and M13 `asFhirMedicationAdministration`, both documented as
// "the M28 FHIR projection". Neither is used here, for one reason that applies to both: their payload
// shapes carry no 42 CFR Part 2 SUD-class flag, and D3 makes SUD redaction default-ON at every FHIR
// egress path. Projecting from those payloads would mean either a SECOND per-resource seam read purely
// to recover the flag, or asserting `sudClass: false` for every medication — which is not a shortcut but
// a Part 2 disclosure. The full DTOs (`MedicationOrderDto`, `AdministrationDto`) carry
// `isSudTreatment` explicitly, so this projects from those and the gate gets a real answer. The two
// payload types are not wrong, they are incomplete for a consent-gated read; adding the flag to them is
// the producer-side fix that would let this switch over.
import {
  type EncounterDomain,
  type MedicationAdministrationDomain,
  type MedicationRequestDomain,
  type PatientRow,
  encounterMapper,
  gateBundleForEgress,
  medicationAdministrationMapper,
  medicationRequestMapper,
  patientMapper,
} from "@chartwarden/fhir";
import type { MapperContext, OperationOutcome } from "@chartwarden/fhir";
import type { AdministrationDto, MedicationOrderDto, PatientIdentity } from "@chartwarden/types";

import {
  getFhirDisclosureConsentEvaluator,
  getFhirMedicationAdministrationProvider,
  getFhirMedicationOrderProvider,
  getFhirPatientAddressReader,
  getFhirPatientReader,
  getFhirSignedEncountersReader,
} from "../seams/index";

/** A FHIR interaction this gateway supports on a resource type. */
export type FhirServedInteraction = "read" | "search-type";

export interface FhirServedResource {
  readonly type: string;
  readonly interactions: readonly FhirServedInteraction[];
  readonly searchParams: readonly string[];
}

/** The ONE list. The CapabilityStatement renders it; the router dispatches on it (see the header). */
export const SERVED_RESOURCES: readonly FhirServedResource[] = [
  { type: "Patient", interactions: ["read", "search-type"], searchParams: ["_id", "identifier"] },
  { type: "Encounter", interactions: ["search-type"], searchParams: ["patient"] },
  {
    type: "MedicationRequest",
    interactions: ["read", "search-type"],
    searchParams: ["patient"],
  },
  {
    type: "MedicationAdministration",
    interactions: ["read", "search-type"],
    searchParams: ["patient"],
  },
] as const;

const SERVED_BY_TYPE = new Map(SERVED_RESOURCES.map((r) => [r.type, r]));

export const servedResource = (type: string): FhirServedResource | undefined =>
  SERVED_BY_TYPE.get(type);

export const supportsInteraction = (type: string, interaction: FhirServedInteraction): boolean =>
  SERVED_BY_TYPE.get(type)?.interactions.includes(interaction) ?? false;

/** How far back a patient-scoped search reaches when the caller names no `_since` (§4.1 R5). */
const DEFAULT_SEARCH_WINDOW_MS = 5 * 365 * 24 * 60 * 60 * 1000;

/** What a projection needs to know about the request it is serving. */
export interface FhirProjectionContext {
  readonly organizationId: string;
  /** The `fhir_client.id` this disclosure is TO — the recipient the D3 consent consult is about. */
  readonly recipientClientId: string;
  readonly tenantFhirHost: string;
  readonly identifierUriBase: string;
  /** The pinned projection instant. Two reads at the same `asOfDate` produce identical bytes (D6). */
  readonly asOfDate: string;
}

/** One projected result set: the resources that survived the gate, plus the advisories to fold in. */
export interface FhirProjectionResult {
  readonly resources: readonly Record<string, unknown>[];
  readonly warnings: readonly OperationOutcome[];
}

const EMPTY: FhirProjectionResult = { resources: [], warnings: [] };

function mapperContext(ctx: FhirProjectionContext, redactSudContent: boolean): MapperContext {
  return {
    organizationId: ctx.organizationId,
    tenantFhirHost: ctx.tenantFhirHost,
    identifierUriBase: ctx.identifierUriBase,
    asOfDate: ctx.asOfDate,
    recipientClientId: ctx.recipientClientId,
    redactSudContent,
    includeProvenance: false,
  };
}

/** M5's `administrative_sex` code → the FHIR `AdministrativeGender` value set. */
function fhirGender(code: string | null | undefined): PatientRow["gender"] {
  switch ((code ?? "").toUpperCase()) {
    case "M":
      return "male";
    case "F":
      return "female";
    case "O":
      return "other";
    default:
      // `U`, an unmapped code and an absent one all mean the same thing to a consumer: the record does
      // not establish it. FHIR spells that `unknown`, which is a value — not an omission.
      return "unknown";
  }
}

/**
 * M5's `PatientIdentity` → the mapper's `PatientRow`.
 *
 * The seam is an identity/matching contract, so it carries identifiers, name, DOB and sex and NOTHING
 * else. Telecom, street address and deceased-date are recorded by the agency but are not reachable
 * through any registered seam, so they are absent here rather than invented. US Core marks them Must
 * Support, which obliges a server to send what it HAS; a projection cannot send what its contract does
 * not expose. `state` is the one address element that IS reachable (M5's `PatientAddressReader`), and it
 * is included because a partial address is still true and a missing one is still absent.
 */
function toPatientRow(identity: PatientIdentity, state: string | null): PatientRow {
  return {
    id: identity.id,
    mrn: identity.mrn,
    firstName: identity.firstName,
    lastName: identity.lastName,
    middleName: null,
    gender: fhirGender(identity.administrativeSex),
    birthDate: identity.dateOfBirth,
    deceasedDateTime: null,
    phone: null,
    email: null,
    addressLines: null,
    city: null,
    state,
    postalCode: null,
  };
}

/** M12 order status → the FHIR `medicationrequest-status` value set. */
function medicationRequestStatus(status: string): MedicationRequestDomain["status"] {
  switch (status) {
    case "active":
    case "transmitted":
    case "ack_received":
      return "active";
    case "completed":
      return "completed";
    case "discontinued":
      return "stopped";
    case "draft":
    case "pending_signature":
    case "verbal_pending":
    case "epcs_identity_pending":
      return "draft";
    case "nack_received":
      // A transmission the pharmacy REFUSED. Not `stopped` (nobody stopped it) and not `active` (it was
      // never dispensed) — `entered-in-error` would be a lie too. `unknown` is the honest cell.
      return "unknown";
    default:
      return "unknown";
  }
}

function toMedicationRequestDomain(order: MedicationOrderDto): MedicationRequestDomain {
  const sig = order.sigStructured as { text?: unknown } | null;
  return {
    id: order.id,
    patientId: order.patientId,
    status: medicationRequestStatus(order.status),
    intent: "order",
    rxnormCode: order.rxnormRxcui,
    rxnormText: order.drugName,
    medicationText: [order.drugName, order.strength, order.doseForm].filter(Boolean).join(" "),
    authoredOn: order.signedAt,
    requesterMdmId: order.prescribingPhysicianMdmId,
    dosageText: typeof sig?.text === "string" ? sig.text : null,
    routeCode: null,
    routeText: order.route,
  };
}

/** M13 administration status → the FHIR `medicationadministration-status` value set. */
function administrationStatus(status: string): MedicationAdministrationDomain["status"] {
  switch (status) {
    case "committed":
      return "completed";
    case "voided":
      return "entered-in-error";
    case "pending_caregiver_review":
      return "in-progress";
    case "superseded":
      // Superseded by a correction. The dose DID happen, so `entered-in-error` would erase a real
      // clinical event; `unknown` says the record no longer speaks for itself, which is true.
      return "unknown";
    default:
      return "unknown";
  }
}

function toAdministrationDomain(dto: AdministrationDto): MedicationAdministrationDomain {
  return {
    id: dto.id,
    patientId: dto.patientId,
    status: administrationStatus(dto.status),
    rxnormCode: dto.rxnormRxcuiSnapshot,
    medicationText: dto.drugNameSnapshot,
    effectiveDateTime: dto.administeredAt,
    effectivePeriod: null,
    medicationRequestId: dto.medicationOrderId,
  };
}

/** M8 encounter status → the FHIR `encounter-status` value set. */
function encounterStatus(status: string): EncounterDomain["status"] {
  switch (status) {
    case "signed":
    case "cosigned":
      return "finished";
    case "voided":
      return "cancelled";
    case "draft":
    case "finalized":
    case "cosign_pending":
      return "in-progress";
    default:
      return "unknown" as EncounterDomain["status"];
  }
}

/** v3-ActCode for a hospice encounter: telephonic visits are virtual, everything else is home health. */
const encounterClass = (encounterType: string): { code: string; display: string } =>
  encounterType === "telephonic"
    ? { code: "VR", display: "virtual" }
    : { code: "HH", display: "home health" };

function toEncounterDomain(digest: {
  encounterId: string;
  patientId: string;
  encounterType: string;
  discipline: string;
  serviceDate: string;
  status: string;
}): EncounterDomain {
  const cls = encounterClass(digest.encounterType);
  return {
    id: digest.encounterId,
    patientId: digest.patientId,
    status: encounterStatus(digest.status),
    classCode: cls.code,
    classDisplay: cls.display,
    // The tenant's own encounter vocabulary, under the tenant's own namespace (D9) — never an invented
    // SNOMED code. A consumer can read the text; a consumer that wants a standard code should ask for
    // one to be mapped rather than be handed a guess.
    typeCode: digest.encounterType,
    typeText: `${digest.encounterType} (${digest.discipline})`,
    practitionerMdmId: null,
    periodStart: digest.serviceDate,
    periodEnd: digest.serviceDate,
  };
}

/** One resource on its way to the D3 gate: the projected body, its subject, and its Part 2 class. */
interface Gated {
  readonly resource: Record<string, unknown>;
  readonly patientId: string;
  readonly sudClass: boolean;
}

/**
 * Run everything through the D3 egress gate. `onSudRedact: "filter"` for every resource here: a
 * medication IS its medication, so a Part 2 drug has no non-SUD residue worth serving, and dropping the
 * resource with a `suppressed` advisory is the §8.2 posture for a wholly-SUD resource. The advisory is
 * what keeps this the right side of §4001 information blocking — the consumer is told the data was
 * withheld and why, rather than handed a silent gap.
 */
async function gate(
  ctx: FhirProjectionContext,
  candidates: readonly Gated[],
): Promise<FhirProjectionResult> {
  if (candidates.length === 0) return EMPTY;
  const result = await gateBundleForEgress(
    getFhirDisclosureConsentEvaluator(),
    {
      organizationId: ctx.organizationId,
      recipientClientId: ctx.recipientClientId,
      asOf: ctx.asOfDate,
    },
    candidates.map((c) => ({
      resource: c.resource,
      patientId: c.patientId,
      sudClass: c.sudClass,
      onSudRedact: "filter" as const,
    })),
  );
  return { resources: result.resources, warnings: result.warnings };
}

/** R4 — project ONE resource by id, or null when this gateway holds no such resource. */
export async function projectResourceById(
  ctx: FhirProjectionContext,
  resourceType: string,
  id: string,
): Promise<FhirProjectionResult | null> {
  if (!supportsInteraction(resourceType, "read")) return null;
  const mctx = mapperContext(ctx, false);

  if (resourceType === "Patient") {
    const identity = await getFhirPatientReader().findById({
      organizationId: ctx.organizationId,
      id,
    });
    if (identity === null) return null;
    const state = await getFhirPatientAddressReader().primaryResidenceState(
      ctx.organizationId,
      identity.id,
    );
    return gate(ctx, [
      {
        resource: patientMapper.map(toPatientRow(identity, state), mctx) as unknown as Record<
          string,
          unknown
        >,
        patientId: identity.id,
        sudClass: false,
      },
    ]);
  }

  if (resourceType === "MedicationRequest") {
    const order = await getFhirMedicationOrderProvider().getMedicationOrder(ctx.organizationId, id);
    if (order === null) return null;
    return gate(ctx, [
      {
        resource: medicationRequestMapper.map(
          toMedicationRequestDomain(order),
          mctx,
        ) as unknown as Record<string, unknown>,
        patientId: order.patientId,
        sudClass: order.isSudTreatment,
      },
    ]);
  }

  if (resourceType === "MedicationAdministration") {
    const dto = await getFhirMedicationAdministrationProvider().getAdministration(
      ctx.organizationId,
      id,
    );
    if (dto === null) return null;
    return gate(ctx, [
      {
        resource: medicationAdministrationMapper.map(
          toAdministrationDomain(dto),
          mctx,
        ) as unknown as Record<string, unknown>,
        patientId: dto.patientId,
        sudClass: dto.isSudTreatment,
      },
    ]);
  }

  return null;
}

/** The Phase-1 type-level search parameters a caller may name. */
export interface FhirSearchParams {
  readonly patient?: string;
  readonly _id?: string;
  readonly identifier?: string;
  readonly _since?: string;
  readonly _count?: number;
}

/**
 * R5 — project a type-level search.
 *
 * Every served search is PATIENT-SCOPED (or identifier-scoped, which resolves to one patient). That is
 * not a limitation of the seams, it is W-FHIR-14: an org-wide unscoped FHIR search is a bulk export
 * wearing a search's clothes, and this gateway has a real bulk-export surface (R7/R9) that is audited,
 * job-tracked and rate-limited for exactly that. A search naming no patient returns an empty Bundle
 * rather than the whole tenant.
 */
export async function projectSearch(
  ctx: FhirProjectionContext,
  resourceType: string,
  params: FhirSearchParams,
): Promise<FhirProjectionResult | null> {
  if (!supportsInteraction(resourceType, "search-type")) return null;
  const mctx = mapperContext(ctx, false);
  const limit = params._count ?? 50;

  if (resourceType === "Patient") {
    // `identifier` is the MRN (D9's per-tenant `.../sid/mrn` system); a `system|value` form is accepted
    // and the system half discarded, because a token search's system is a namespace assertion and this
    // gateway serves exactly one MRN namespace — its own tenant's.
    const identity =
      params._id !== undefined
        ? await getFhirPatientReader().findById({
            organizationId: ctx.organizationId,
            id: params._id,
          })
        : params.identifier !== undefined
          ? await getFhirPatientReader().findByMrn({
              organizationId: ctx.organizationId,
              mrn: params.identifier.includes("|")
                ? (params.identifier.split("|")[1] ?? "")
                : params.identifier,
            })
          : null;
    if (identity === null) return EMPTY;
    const state = await getFhirPatientAddressReader().primaryResidenceState(
      ctx.organizationId,
      identity.id,
    );
    return gate(ctx, [
      {
        resource: patientMapper.map(toPatientRow(identity, state), mctx) as unknown as Record<
          string,
          unknown
        >,
        patientId: identity.id,
        sudClass: false,
      },
    ]);
  }

  const patientId = params.patient;
  if (patientId === undefined) return EMPTY;
  const since =
    params._since ?? new Date(Date.parse(ctx.asOfDate) - DEFAULT_SEARCH_WINDOW_MS).toISOString();

  if (resourceType === "Encounter") {
    const digests = await getFhirSignedEncountersReader().signedEncountersForPatientSince(
      ctx.organizationId,
      patientId,
      since,
    );
    return gate(
      ctx,
      digests.slice(0, limit).map((d) => ({
        resource: encounterMapper.map(toEncounterDomain(d), mctx) as unknown as Record<
          string,
          unknown
        >,
        patientId: d.patientId,
        // The Encounter projection carries no narrative — id, status, class, type, subject and period
        // only — so there is no 42 CFR Part 2 content in it to classify. The gate still runs, because
        // `allowed: false` (no consent to disclose to this recipient at all) must still filter it.
        sudClass: false,
      })),
    );
  }

  if (resourceType === "MedicationRequest") {
    const orders = await getFhirMedicationOrderProvider().getMedicationsSince(
      ctx.organizationId,
      patientId,
      since,
    );
    return gate(
      ctx,
      orders.slice(0, limit).map((o) => ({
        resource: medicationRequestMapper.map(
          toMedicationRequestDomain(o),
          mctx,
        ) as unknown as Record<string, unknown>,
        patientId: o.patientId,
        sudClass: o.isSudTreatment,
      })),
    );
  }

  if (resourceType === "MedicationAdministration") {
    const dtos = await getFhirMedicationAdministrationProvider().getAdministrationsSince(
      ctx.organizationId,
      patientId,
      since,
    );
    return gate(
      ctx,
      dtos.slice(0, limit).map((d) => ({
        resource: medicationAdministrationMapper.map(
          toAdministrationDomain(d),
          mctx,
        ) as unknown as Record<string, unknown>,
        patientId: d.patientId,
        sudClass: d.isSudTreatment,
      })),
    );
  }

  return EMPTY;
}
