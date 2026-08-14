// apps/backend/src/modules/05-patient/seams/drizzle-stores.ts — the Drizzle-backed
// PatientReaderStore + PatientMutatorStore (TASK-002, ARCH-003). Until this file, the composition
// root registered BOTH seams over in-memory Maps on a db boot: `getSeam("PatientReader")` answered
// "no such patient" about a database it never read (M29's match cascade demoted every inbound ADT to
// unmatched), and a PatientMutator apply "succeeded" against rows that exist nowhere.
//
// TENANCY: every method on both ports carries `organizationId` explicitly (the M29 cascade calls
// them from inbound-feed processing, not always inside a tenant request), so each opens its own
// `withOrgContext` envelope AND keeps the explicit organization_id predicate as the second wall —
// the M7 drizzle-store precedent. `userId: ""` (an identity read/apply on behalf of the platform
// carries no acting membership; withOrgContext maps "" to a NULL audit actor).
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { PatientIdentity } from "@wardenx/types";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { OutboxPublishPort } from "../../../bootstrap/outbox-persister";
import { PRIMARY_RN_ASSIGNMENT_ROLE, type CareTeamStore } from "./care-team-provider";
import type { CaseloadStore } from "./caseload-provider";
import type { PatientMutatorStore } from "./patient-mutator";
import type { PatientReaderStore } from "./patient-reader";

const P = schema.patients;
const ID = schema.patientIdentifiers;
const ADDR = schema.patientAddresses;
const PHONE = schema.patientPhones;
const EMAIL = schema.patientEmails;
const ALIAS = schema.patientNameAliases;
const COMM = schema.patientCommunicationPreferences;
const PA = schema.patientAssignments;

/** The seam envelope's actor id — a cross-module identity read has no acting membership. */
const SEAM_SYSTEM_USER_ID = "";

/** Identifier kinds that surface as `PatientIdentity.externalMrns` (issuer = assigning authority). */
const EXTERNAL_MRN_KINDS = ["partner_mrn", "prior_mrn", "hospice_external"] as const;

type PatientRow = {
  id: string;
  organizationId: string;
  mrn: string;
  legalLastName: string;
  legalFirstName: string;
  dob: string;
  sexAssignedAtBirth: string;
  mergedIntoId: string | null;
  providerEntityId: string | null;
};

const PATIENT_COLUMNS = {
  id: P.id,
  organizationId: P.organizationId,
  mrn: P.mrn,
  legalLastName: P.legalLastName,
  legalFirstName: P.legalFirstName,
  dob: P.dob,
  sexAssignedAtBirth: P.sexAssignedAtBirth,
  mergedIntoId: P.mergedIntoId,
  providerEntityId: P.providerEntityId,
} as const;

type SeamTx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

/**
 * Project patient rows to {@link PatientIdentity}, batch-loading the external MRNs + the ssn tail
 * from patient_identifier in ONE round-trip (never N+1). `ssnLast4` comes from the CURRENT
 * (effective_to IS NULL) ssn identifier's plaintext display tail — the envelope-encrypted value
 * itself never crosses the seam.
 */
async function identitiesFor(tx: SeamTx, rows: readonly PatientRow[]): Promise<PatientIdentity[]> {
  if (rows.length === 0) return [];
  const idRows = await tx
    .select({
      patientId: ID.patientId,
      kind: ID.kind,
      value: ID.value,
      valueLast4: ID.valueLast4,
      issuer: ID.issuer,
    })
    .from(ID)
    .where(
      and(
        inArray(
          ID.patientId,
          rows.map((r) => r.id),
        ),
        isNull(ID.effectiveTo),
      ),
    );
  const externalByPatient = new Map<string, Array<{ assigningAuthority: string; value: string }>>();
  const ssnByPatient = new Map<string, string>();
  for (const r of idRows) {
    if ((EXTERNAL_MRN_KINDS as readonly string[]).includes(r.kind) && r.value !== null) {
      const bucket = externalByPatient.get(r.patientId) ?? [];
      bucket.push({ assigningAuthority: (r.issuer ?? "").toUpperCase(), value: r.value });
      externalByPatient.set(r.patientId, bucket);
    } else if (r.kind === "ssn" && r.valueLast4 !== null) {
      ssnByPatient.set(r.patientId, r.valueLast4);
    }
  }
  return rows.map((r) => ({
    id: r.id,
    organizationId: r.organizationId,
    mrn: r.mrn,
    externalMrns: externalByPatient.get(r.id) ?? [],
    lastName: r.legalLastName,
    firstName: r.legalFirstName,
    dateOfBirth: r.dob,
    administrativeSex: r.sexAssignedAtBirth,
    ...(ssnByPatient.has(r.id) ? { ssnLast4: ssnByPatient.get(r.id) } : {}),
    ...(r.mergedIntoId !== null ? { mergedIntoId: r.mergedIntoId } : {}),
    // GAP-044 — the agency M29's manual lab bind stamps on the materialized observation (ARCH-011).
    providerEntityId: r.providerEntityId,
  }));
}

/** Build the Drizzle {@link PatientReaderStore} over `patient` + `patient_identifier`. */
export function createDrizzlePatientReaderStore(db: DbClient): PatientReaderStore {
  const read = <T>(organizationId: string, fn: (tx: SeamTx) => Promise<T>): Promise<T> =>
    withOrgContext(db, { organizationId, userId: SEAM_SYSTEM_USER_ID }, fn);

  const one = async (
    tx: SeamTx,
    where: ReturnType<typeof and>,
  ): Promise<PatientIdentity | null> => {
    const rows = await tx.select(PATIENT_COLUMNS).from(P).where(where).limit(1);
    const [identity] = await identitiesFor(tx, rows);
    return identity ?? null;
  };
  const many = async (tx: SeamTx, where: ReturnType<typeof and>): Promise<PatientIdentity[]> => {
    const rows = await tx.select(PATIENT_COLUMNS).from(P).where(where);
    return identitiesFor(tx, rows);
  };

  return {
    byMrn(organizationId, mrn) {
      return read(organizationId, (tx) =>
        one(tx, and(eq(P.organizationId, organizationId), eq(P.mrn, mrn))),
      );
    },
    byExternalMrn(organizationId, assigningAuthority, value) {
      return read(organizationId, async (tx) => {
        const hit = await tx
          .select({ patientId: ID.patientId })
          .from(ID)
          .where(
            and(
              eq(ID.organizationId, organizationId),
              inArray(ID.kind, [...EXTERNAL_MRN_KINDS]),
              sql`upper(coalesce(${ID.issuer}, '')) = ${assigningAuthority.toUpperCase()}`,
              eq(ID.value, value),
              isNull(ID.effectiveTo),
            ),
          )
          .limit(1);
        if (!hit[0]) return null;
        return one(tx, and(eq(P.organizationId, organizationId), eq(P.id, hit[0].patientId)));
      });
    },
    bySsnLast4AndDob(organizationId, ssnLast4, dateOfBirth) {
      return read(organizationId, async (tx) => {
        const hits = await tx
          .select({ patientId: ID.patientId })
          .from(ID)
          .where(
            and(
              eq(ID.organizationId, organizationId),
              eq(ID.kind, "ssn"),
              eq(ID.valueLast4, ssnLast4),
              isNull(ID.effectiveTo),
            ),
          );
        if (hits.length === 0) return [];
        return many(
          tx,
          and(
            eq(P.organizationId, organizationId),
            inArray(
              P.id,
              hits.map((h) => h.patientId),
            ),
            eq(P.dob, dateOfBirth),
          ),
        );
      });
    },
    byNameDobSex(organizationId, lastName, firstName, dateOfBirth, administrativeSex) {
      return read(organizationId, (tx) =>
        many(
          tx,
          and(
            eq(P.organizationId, organizationId),
            sql`upper(${P.legalLastName}) = ${lastName.toUpperCase()}`,
            sql`upper(${P.legalFirstName}) = ${firstName.toUpperCase()}`,
            eq(P.dob, dateOfBirth),
            eq(P.sexAssignedAtBirth, administrativeSex),
          ),
        ),
      );
    },
    byLooseName(organizationId, lastName, firstNameInitial, dateOfBirth) {
      return read(organizationId, (tx) =>
        many(
          tx,
          and(
            eq(P.organizationId, organizationId),
            sql`upper(${P.legalLastName}) = ${lastName.toUpperCase()}`,
            eq(P.dob, dateOfBirth),
            ...(firstNameInitial === undefined
              ? []
              : [sql`upper(${P.legalFirstName}) like ${`${firstNameInitial.toUpperCase()}%`}`]),
          ),
        ),
      );
    },
    byId(organizationId, id) {
      return read(organizationId, (tx) =>
        one(tx, and(eq(P.organizationId, organizationId), eq(P.id, id))),
      );
    },
  };
}

/** Deps for the Drizzle mutator store — the m5 catalog publisher is REQUIRED for the §4.6 emit. */
export interface DrizzlePatientMutatorStoreDeps {
  /** Catalog-validating tx publisher (callerModule `m5`) — `m5.patient.updated` rides the emit tx. */
  readonly outbox: OutboxPublishPort;
}

/** ISO date (yyyy-mm-dd) for `effective_from` on appended rows — matches the route service. */
const todayIso = (): string => new Date().toISOString().slice(0, 10);

/**
 * Build the Drizzle {@link PatientMutatorStore} (M5 §4.9 / D12). Field mapping is EXPLICIT and
 * conservative — every appliable scalar lands where the schema actually holds it:
 *   patient row: legalFirstName/legalMiddleName/legalLastName, dateOfBirth→dob,
 *                administrativeSex→sex_assigned_at_birth, maritalStatus→marital_status_code
 *   patient_name_alias(kind='preferred'): preferredName
 *   patient_communication_preferences: preferredLanguage→preferred_language_code (upsert)
 *   patient_phone(kind=home|mobile): phoneHome/phoneMobile (append; no dedupe beyond exact e164)
 *   patient_email: email (append)
 * An unknown scalar key REFUSES (typed throw) rather than being dropped silently — the orchestrator
 * already stripped the forbidden set, so an unmapped key here is a contract drift, not partner noise.
 */
export function createDrizzlePatientMutatorStore(
  db: DbClient,
  deps: DrizzlePatientMutatorStoreDeps,
): PatientMutatorStore {
  const write = <T>(organizationId: string, fn: (tx: SeamTx) => Promise<T>): Promise<T> =>
    withOrgContext(db, { organizationId, userId: SEAM_SYSTEM_USER_ID }, fn);

  return {
    async applyFields(organizationId, patientId, fields) {
      await write(organizationId, async (tx) => {
        const patientPatch: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(fields)) {
          switch (key) {
            case "legalFirstName":
              patientPatch.legalFirstName = value;
              break;
            case "legalMiddleName":
              patientPatch.legalMiddleName = value;
              break;
            case "legalLastName":
              patientPatch.legalLastName = value;
              break;
            case "dateOfBirth":
              patientPatch.dob = value;
              break;
            case "administrativeSex":
              patientPatch.sexAssignedAtBirth = value;
              break;
            case "maritalStatus":
              patientPatch.maritalStatusCode = value;
              break;
            case "preferredName":
              await tx.insert(ALIAS).values({
                organizationId,
                patientId,
                kind: "preferred",
                fullName: String(value),
              });
              break;
            case "preferredLanguage":
              await tx
                .insert(COMM)
                .values({ patientId, organizationId, preferredLanguageCode: String(value) })
                .onConflictDoUpdate({
                  target: COMM.patientId,
                  set: { preferredLanguageCode: String(value) },
                });
              break;
            case "phoneHome":
              await tx
                .insert(PHONE)
                .values({ organizationId, patientId, kind: "home", e164: String(value) });
              break;
            case "phoneMobile":
              await tx
                .insert(PHONE)
                .values({ organizationId, patientId, kind: "mobile", e164: String(value) });
              break;
            case "email":
              await tx.insert(EMAIL).values({ organizationId, patientId, email: String(value) });
              break;
            default:
              throw new Error(
                `PatientMutatorStore.applyFields: unmapped scalar field '${key}' — the appliable-field list and this store have drifted; refusing rather than dropping it silently`,
              );
          }
        }
        if (Object.keys(patientPatch).length > 0) {
          patientPatch.updatedAt = new Date();
          await tx
            .update(P)
            .set(patientPatch)
            .where(and(eq(P.organizationId, organizationId), eq(P.id, patientId)));
        }
      });
    },

    async appendAddress(organizationId, patientId, address) {
      // The D5 append is all-or-nothing on the NOT-NULL address core: a partner patch missing
      // line1/city/postal cannot form a valid `patient_address` row, so it creates NOTHING and the
      // orchestrator reports `addressVersionCreated: false` — never a half-row.
      if (!address.line1 || !address.city || !address.postal) return false;
      const { line1, city, postal } = address;
      return write(organizationId, async (tx) => {
        const inserted = await tx
          .insert(ADDR)
          .values({
            organizationId,
            patientId,
            line1,
            line2: address.line2 ?? null,
            city,
            state: address.state ?? null,
            postalCode: postal,
            isPrimary: false, // a partner-proposed address never displaces the primary silently
            effectiveFrom: todayIso(),
          })
          .returning({ id: ADDR.id });
        return inserted.length > 0;
      });
    },

    async addExternalMrns(organizationId, patientId, mrns) {
      return write(organizationId, async (tx) => {
        let added = 0;
        for (const m of mrns) {
          const issuer = m.assigningAuthority.toUpperCase();
          // The partner-MRN index is (org, issuer, value) — skip an exact duplicate, count the rest.
          const existing = await tx
            .select({ id: ID.id })
            .from(ID)
            .where(
              and(
                eq(ID.organizationId, organizationId),
                eq(ID.kind, "partner_mrn"),
                eq(ID.issuer, issuer),
                eq(ID.value, m.value),
              ),
            )
            .limit(1);
          if (existing[0]) continue;
          await tx.insert(ID).values({
            organizationId,
            patientId,
            kind: "partner_mrn",
            value: m.value,
            issuer,
            effectiveFrom: todayIso(),
          });
          added += 1;
        }
        return added;
      });
    },

    async emitPatientUpdated(organizationId, patientId, changed) {
      // The port shape gives the emit its own envelope (applyFields/appendAddress each committed on
      // their own tx above); the catalog publisher still validates + persists atomically WITHIN it.
      await write(organizationId, (tx) =>
        deps.outbox.publish(tx, {
          eventName: "m5.patient.updated",
          payload: { patientId, organizationId, changed: [...changed] },
          organizationId,
          aggregateKind: "patient",
          aggregateId: patientId,
          callerModule: "m5",
        }),
      );
    },
  };
}

/**
 * Build the Drizzle {@link CaseloadStore} over `patient_assignment` (§3.5) — an OPEN row
 * (`unassigned_at IS NULL`) for (org, clinician_user_id, patient_id). Until this store existed,
 * `registerPatientSeams()` had no Drizzle-backed option to pass, so the composition root registered
 * `CaseloadProvider` over the empty in-memory default on every real boot: `caseload_membership` /
 * `caseload_or_scope` (consumed by M7/M8/M9/M12/M13/M14/M22/M33/M34) silently denied every caller
 * outside an org-wide-scope role, regardless of real `patient_assignment` rows. `clinicianUserId`
 * (not a membership id) is the RAW Better Auth user id — the same id space `AbacContext.userId`
 * carries (`request.context.userId = snap.userId`, never resolved to a membership id), so no id
 * translation is needed here.
 */
export function createDrizzleCaseloadStore(db: DbClient): CaseloadStore {
  const read = <T>(organizationId: string, fn: (tx: SeamTx) => Promise<T>): Promise<T> =>
    withOrgContext(db, { organizationId, userId: SEAM_SYSTEM_USER_ID }, fn);

  return {
    async isAssigned(organizationId, userId, patientId) {
      return read(organizationId, async (tx) => {
        const rows = await tx
          .select({ id: PA.id })
          .from(PA)
          .where(
            and(
              eq(PA.organizationId, organizationId),
              eq(PA.clinicianUserId, userId),
              eq(PA.patientId, patientId),
              isNull(PA.unassignedAt),
            ),
          )
          .limit(1);
        return rows.length > 0;
      });
    },
    async assignedPatientIds(organizationId, userId) {
      return read(organizationId, async (tx) => {
        const rows = await tx
          .selectDistinct({ patientId: PA.patientId })
          .from(PA)
          .where(
            and(
              eq(PA.organizationId, organizationId),
              eq(PA.clinicianUserId, userId),
              isNull(PA.unassignedAt),
            ),
          );
        return rows.map((r) => r.patientId);
      });
    },
  };
}

/**
 * The real M5 CareTeamProvider store (GAP-059) — the reverse of {@link createDrizzleCaseloadStore}
 * over the same `patient_assignment` open rows: every distinct clinician on ONE patient's team,
 * instead of every patient on one clinician's caseload. M36's `syncCareTeamChannel` consumes this
 * to reconcile a `care_team` channel's auto-sourced membership (M36 spec D5).
 */
export function createDrizzleCareTeamStore(db: DbClient): CareTeamStore {
  return {
    async listMembers(organizationId, patientId) {
      return withOrgContext(db, { organizationId, userId: SEAM_SYSTEM_USER_ID }, async (tx) => {
        const rows = await tx
          .selectDistinct({ clinicianUserId: PA.clinicianUserId })
          .from(PA)
          .where(
            and(
              eq(PA.organizationId, organizationId),
              eq(PA.patientId, patientId),
              isNull(PA.unassignedAt),
            ),
          );
        return rows.map((r) => r.clinicianUserId);
      });
    },

    // GAP-022 — the RN case manager, for M13's §2.9 D10 caregiver-attested review gate. `patient_assignment`
    // carries a partial unique index on (patient_id, role) WHERE role='primary_rn' AND unassigned_at IS NULL,
    // so at most one row can match; `limit(1)` reflects that invariant rather than papering over a bad query.
    async findPrimaryRn(organizationId, patientId) {
      return withOrgContext(db, { organizationId, userId: SEAM_SYSTEM_USER_ID }, async (tx) => {
        const [row] = await tx
          .select({ clinicianUserId: PA.clinicianUserId })
          .from(PA)
          .where(
            and(
              eq(PA.organizationId, organizationId),
              eq(PA.patientId, patientId),
              eq(PA.role, PRIMARY_RN_ASSIGNMENT_ROLE),
              isNull(PA.unassignedAt),
            ),
          )
          .limit(1);
        return row?.clinicianUserId ?? null;
      });
    },
  };
}
