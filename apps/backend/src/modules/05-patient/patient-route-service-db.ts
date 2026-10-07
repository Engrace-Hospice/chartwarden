// apps/backend/src/modules/05-patient — PRODUCTION PatientRouteService, READ-first (M5 §4.2).
//
// The census + chart-resolve READS (list / getPatient) run on a real Drizzle query over the M5-owned
// `patient` table inside withOrgContext, so RLS scopes by app.org_id. The census fields (mrn, legal
// name, dob, status) are PLAINTEXT on `patient` (mrn is denormalised there for exactly this hot path;
// only ssn/state_id/mbi are envelope-encrypted, on `patient_identifier`) — so no per-row decryption.
//
// All WRITES are real: admit (§7.1 matcher + patient/identifier insert), addAddress (§7.4), and the
// amendment lifecycle (§7.7 submit/decide) run under withOrgContext/RLS. Each write publishes its spec'd
// `m5.patient.*` event (GAP-016) through the injected m5 outbox port ON THE SAME TRANSACTION, so a failed
// publish rolls the write back. Remaining follow-ups: SSN + name-alias storage on admit, soft_review
// match-review rows.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { NotFoundError } from "@wardenx/types";
import { WardenXError } from "@wardenx/types";
import { type SQL, and, asc, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import type { M5OutboxPort } from "./deceased-db";
import { insertSoftMatchReviews } from "./match-review-db";
import { type MatchCandidate, runMatch } from "./matching/matcher";
import { normalizeSubject } from "./matching/normalize";
import { type PrivacyFlag, isSudReadAllowed } from "./privacy/index";
import type {
  AddAddressInput,
  AddPatientPayerInput,
  AddressView,
  AdmitInput,
  AdmitResult,
  AssignmentView,
  CareTeamView,
  CensusMetrics,
  CreatePatientAssignmentInput,
  DemographicsView,
  IdentifierView,
  PatientPayerView,
  PatientRouteService,
  PatientView,
  PrivacyFlagsView,
} from "./routes/service";

const ID = schema.patientIdentifiers;
const ADDR = schema.patientAddresses;
const PAYER = schema.patientPayers;
const ALIAS = schema.patientNameAliases;
const COMM = schema.patientCommunicationPreferences;
const ASSIGN = schema.patientAssignments;
const PCG = schema.patientCaregivers;
const CG = schema.caregivers;
const EC = schema.emergencyContacts;
const PFS = schema.patientPrivacyFlagSnapshots;
const MEM = schema.memberships;
const SENSITIVE_KINDS = new Set(["ssn", "state_id"]);

const P = schema.patients;
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

interface ListQuery {
  readonly q?: string;
  readonly status?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

const VIEW_COLUMNS = {
  id: P.id,
  organizationId: P.organizationId,
  mrn: P.mrn,
  lastName: P.legalLastName,
  firstName: P.legalFirstName,
  dob: P.dob,
  status: P.status,
} as const;

function toView(r: {
  id: string;
  organizationId: string;
  mrn: string;
  lastName: string;
  firstName: string;
  dob: string;
  status: string;
}): PatientView {
  return {
    id: r.id,
    organizationId: r.organizationId,
    mrn: r.mrn,
    lastName: r.lastName,
    firstName: r.firstName,
    dob: r.dob,
    status: r.status,
  };
}

/** Opaque ascending cursor over (lastName, firstName, id). */
function encode(v: PatientView): string {
  return Buffer.from(JSON.stringify([v.lastName, v.firstName, v.id]), "utf8").toString("base64url");
}
function decode(cursor: string): [string, string, string] | null {
  try {
    const a = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return Array.isArray(a) && a.length === 3 ? (a as [string, string, string]) : null;
  } catch {
    return null;
  }
}

/** Build the production PatientRouteService — reads + writes are real Drizzle over the patient tables. */
const NOOP_OUTBOX: M5OutboxPort = { publish: async () => undefined };
export function createDbPatientRouteService(
  db: DbClient,
  outbox: M5OutboxPort = NOOP_OUTBOX,
): PatientRouteService {
  const list = async (
    organizationId: string,
    query: ListQuery,
    scope: readonly string[] | null,
  ) => {
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(query.limit ?? DEFAULT_LIMIT)));
    const c = query.cursor ? decode(query.cursor) : null;
    // §7.5 (F-096) — the caseload narrowing, IN THE SQL. `scope === null` is the org-wide reader; a
    // named set becomes `patient.id = ANY(:ids)`, which is the filter the spec asks for by name.
    //
    // The empty set returns a constant-false predicate rather than NO predicate. That is the whole security property:
    // `if (scope.length > 0)` reads as a harmless guard against an empty `IN ()` and means an actor with
    // no caseload reads the entire tenant — the fail-open this narrowing exists to prevent, aimed at
    // exactly the actor who should see least. Drizzle's `inArray` with an empty array is itself a
    // no-op in some versions, so the constant is written out rather than relied upon.
    const narrowing =
      scope === null
        ? undefined
        : scope.length === 0
          ? (sql`false` as SQL)
          : (inArray(P.id, [...scope]) as SQL);
    const where = and(
      narrowing,
      query.status ? eq(P.status, query.status as typeof P.$inferSelect.status) : undefined,
      query.q
        ? (or(
            ilike(P.legalLastName, `%${query.q}%`),
            ilike(P.legalFirstName, `%${query.q}%`),
            ilike(P.mrn, `%${query.q}%`),
          ) as SQL)
        : undefined,
      // ascending (lastName, firstName, id) strictly after the cursor row
      c
        ? (sql`(${P.legalLastName}, ${P.legalFirstName}, ${P.id}) > (${c[0]}, ${c[1]}, ${c[2]}::uuid)` as SQL)
        : undefined,
    );
    return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const rows = await tx
        .select(VIEW_COLUMNS)
        .from(P)
        .where(where)
        .orderBy(asc(P.legalLastName), asc(P.legalFirstName), asc(P.id))
        .limit(limit + 1);
      const views = rows.map(toView);
      if (views.length > limit) {
        const page = views.slice(0, limit);
        return { items: page, nextCursor: encode(page[page.length - 1]!) };
      }
      return { items: views, nextCursor: null };
    });
  };

  // §4.2 census KPI strip — a single COUNT…GROUP BY status, org-scoped by RLS under withOrgContext.
  const censusMetrics = async (organizationId: string): Promise<CensusMetrics> =>
    withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const rows = await tx
        .select({ status: P.status, n: sql<number>`count(*)::int` })
        .from(P)
        .groupBy(P.status);
      const byStatus: Record<string, number> = {};
      let total = 0;
      for (const r of rows) {
        byStatus[r.status] = r.n;
        total += r.n;
      }
      return { total, byStatus };
    });

  const getPatient = async (organizationId: string, id: string): Promise<PatientView | null> =>
    withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const rows = await tx.select(VIEW_COLUMNS).from(P).where(eq(P.id, id)).limit(1);
      return rows[0] ? toView(rows[0]) : null;
    });

  // §3.3 Demographics tab: legal name parts + DOB + the USCDI SOGI/race/ethnicity/marital codes
  // (M38 value-set labels resolved on the client) + preferred language (a left-join on the
  // one-row-per-patient comm preference) + name aliases. RLS scopes everything to app.org_id.
  const getDemographics = async (
    organizationId: string,
    id: string,
  ): Promise<DemographicsView | null> =>
    withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const rows = await tx
        .select({
          id: P.id,
          mrn: P.mrn,
          legalFirstName: P.legalFirstName,
          legalMiddleName: P.legalMiddleName,
          legalLastName: P.legalLastName,
          legalNameSuffix: P.legalNameSuffix,
          dob: P.dob,
          status: P.status,
          sexAssignedAtBirth: P.sexAssignedAtBirth,
          genderIdentityCode: P.genderIdentityCode,
          sexualOrientationCode: P.sexualOrientationCode,
          pronounsCode: P.pronounsCode,
          maritalStatusCode: P.maritalStatusCode,
          raceCodes: P.raceCodes,
          ethnicityCodes: P.ethnicityCodes,
          preferredLanguageCode: COMM.preferredLanguageCode,
        })
        .from(P)
        .leftJoin(COMM, eq(COMM.patientId, P.id))
        .where(eq(P.id, id))
        .limit(1);
      const r = rows[0];
      if (!r) return null;
      const aliases = await tx
        .select({
          kind: ALIAS.kind,
          fullName: ALIAS.fullName,
          firstName: ALIAS.firstName,
          middleName: ALIAS.middleName,
          lastName: ALIAS.lastName,
        })
        .from(ALIAS)
        .where(eq(ALIAS.patientId, id))
        .orderBy(asc(ALIAS.kind));
      return {
        id: r.id,
        mrn: r.mrn,
        legalFirstName: r.legalFirstName,
        legalMiddleName: r.legalMiddleName ?? null,
        legalLastName: r.legalLastName,
        legalNameSuffix: r.legalNameSuffix ?? null,
        dob: r.dob,
        status: r.status,
        sexAssignedAtBirth: r.sexAssignedAtBirth,
        genderIdentityCode: r.genderIdentityCode ?? null,
        sexualOrientationCode: r.sexualOrientationCode ?? null,
        pronounsCode: r.pronounsCode ?? null,
        maritalStatusCode: r.maritalStatusCode ?? null,
        raceCodes: r.raceCodes ?? [],
        ethnicityCodes: r.ethnicityCodes ?? [],
        preferredLanguageCode: r.preferredLanguageCode ?? null,
        aliases: aliases.map((a) => ({
          kind: a.kind,
          fullName: a.fullName ?? null,
          firstName: a.firstName ?? null,
          middleName: a.middleName ?? null,
          lastName: a.lastName ?? null,
        })),
      };
    });

  // §3.3/§2.2 Identifiers tab. MASKED BY CONSTRUCTION: ssn/state_id rows return `value: null` and only
  // the `value_last4` tail — the `value_encrypted` ciphertext is NEVER selected here, so no decryption
  // and no leak. Full reveal is a separate `phi.read_ssn`-gated read (M5 SSN decryption follow-up).
  const getIdentifiers = async (
    organizationId: string,
    id: string,
  ): Promise<IdentifierView[] | null> =>
    withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const exists = await tx.select({ id: P.id }).from(P).where(eq(P.id, id)).limit(1);
      if (!exists[0]) return null;
      const rows = await tx
        .select({
          id: ID.id,
          kind: ID.kind,
          value: ID.value,
          valueLast4: ID.valueLast4,
          issuer: ID.issuer,
          effectiveFrom: ID.effectiveFrom,
          effectiveTo: ID.effectiveTo,
        })
        .from(ID)
        .where(eq(ID.patientId, id))
        .orderBy(asc(ID.kind), asc(ID.effectiveFrom));
      return rows.map((r) => {
        const sensitive = SENSITIVE_KINDS.has(r.kind);
        return {
          id: r.id,
          kind: r.kind,
          value: sensitive ? null : r.value,
          last4: sensitive ? (r.valueLast4 ?? null) : null,
          sensitive,
          issuer: r.issuer ?? null,
          effectiveFrom: r.effectiveFrom,
          effectiveTo: r.effectiveTo ?? null,
        };
      });
    });

  // Insert the patient row (+ its mrn / mbi identifiers) — the census reads patient.mrn (denormalised),
  // patient_identifier is the source of truth. SSN is NOT stored here (envelope-encrypted; a follow-up),
  // nor are name_alias / address / phone / email (also follow-ups). Returns the new patient id.
  type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
  const emitPatientEvent = (
    tx: Tx,
    organizationId: string,
    patientId: string,
    eventName: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> =>
    outbox.publish(tx as unknown as DbClient, {
      eventName,
      payload: { patientId, organizationId, ...extra },
      organizationId,
      aggregateKind: "patient",
      aggregateId: patientId,
    });

  async function insertPatient(tx: Tx, organizationId: string, input: AdmitInput): Promise<string> {
    const mrn = `MRN-${crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
    const today = new Date().toISOString().slice(0, 10);
    const inserted = (await tx
      .insert(P)
      .values({
        organizationId,
        mrn,
        legalFirstName: input.firstName,
        legalLastName: input.lastName,
        dob: input.dob,
        sexAssignedAtBirth: input.administrativeSex,
        status: "prospective",
      })
      .returning({ id: P.id })) as Array<{ id: string }>;
    const patientId = inserted[0]!.id;
    await tx
      .insert(ID)
      .values({ patientId, organizationId, kind: "mrn", value: mrn, effectiveFrom: today });
    if (input.mbi) {
      await tx
        .insert(ID)
        .values({ patientId, organizationId, kind: "mbi", value: input.mbi, effectiveFrom: today });
    }
    await emitPatientEvent(tx, organizationId, patientId, "m5.patient.created", { mrn });
    return patientId;
  }

  // §7.1 admission: run the matcher against the org's existing patients (name + dob + plaintext MBI;
  // SSN feeds only the deterministic SSN+DOB rule, which can't fire since candidate SSNs aren't loaded —
  // no decryption). hard_block → 409 at the route; otherwise insert and return created/soft_review.
  const admit = async (
    organizationId: string,
    input: AdmitInput,
    actorUserId: string,
  ): Promise<AdmitResult> =>
    withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
      const incoming = normalizeSubject(input);
      if (!input.bypassMatchReview) {
        const candRows = await tx
          .select({
            id: P.id,
            lastName: P.legalLastName,
            firstName: P.legalFirstName,
            dob: P.dob,
            mbi: ID.value,
          })
          .from(P)
          .leftJoin(ID, and(eq(ID.patientId, P.id), eq(ID.kind, "mbi")));
        const candidates: MatchCandidate[] = candRows.map((r) => ({
          ...normalizeSubject({
            lastName: r.lastName,
            firstName: r.firstName,
            dob: r.dob,
            mbi: r.mbi,
          }),
          id: r.id,
        }));
        const result = runMatch(incoming, candidates);
        if (result.outcome === "hard_block") {
          return {
            outcome: "hard_block",
            existingPatientId: result.existingPatientId,
            matchedOn: String(result.matchedOn),
          };
        }
        const patientId = await insertPatient(tx, organizationId, input);
        // §7.3 (GAP-019): one open patient_match_review per soft candidate, in this same transaction.
        if (result.outcome === "soft_review") {
          const matchReviewIds = await insertSoftMatchReviews(
            tx,
            organizationId,
            patientId,
            incoming,
            result.reviewCandidates,
          );
          return { outcome: "soft_review", patientId, matchReviewIds };
        }
        return { outcome: "created", patientId };
      }
      return { outcome: "created", patientId: await insertPatient(tx, organizationId, input) };
    });

  const SIXTY_DAYS_MS = 60 * 24 * 3600 * 1000;

  // §3.3 / D5: the append-only address history. `current` (effective_to IS NULL) rows render as the
  // live addresses; closed rows render as history. RLS scopes by app.org_id. 404 (null) when the
  // patient is absent / out of org (§7.5 no-leak), mirroring getIdentifiers.
  const listAddresses = async (
    organizationId: string,
    patientId: string,
  ): Promise<AddressView[] | null> =>
    withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const exists = await tx.select({ id: P.id }).from(P).where(eq(P.id, patientId)).limit(1);
      if (!exists[0]) return null;
      const rows = await tx
        .select({
          id: ADDR.id,
          kind: ADDR.kind,
          line1: ADDR.line1,
          line2: ADDR.line2,
          city: ADDR.city,
          state: ADDR.state,
          postalCode: ADDR.postalCode,
          country: ADDR.country,
          county: ADDR.county,
          isPrimary: ADDR.isPrimary,
          effectiveFrom: ADDR.effectiveFrom,
          effectiveTo: ADDR.effectiveTo,
          geocodeLat: ADDR.geocodeLat,
          geocodeLng: ADDR.geocodeLng,
        })
        .from(ADDR)
        .where(eq(ADDR.patientId, patientId))
        // current first (effective_to NULLS FIRST via the boolean), then primary, then newest.
        .orderBy(asc(ADDR.effectiveTo), desc(ADDR.isPrimary), desc(ADDR.effectiveFrom));
      return rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        line1: r.line1,
        line2: r.line2 ?? null,
        city: r.city,
        state: r.state ?? null,
        postalCode: r.postalCode,
        country: r.country,
        county: r.county ?? null,
        isPrimary: r.isPrimary,
        current: r.effectiveTo === null,
        effectiveFrom: r.effectiveFrom,
        effectiveTo: r.effectiveTo ?? null,
        geocodeLat: r.geocodeLat ?? null,
        geocodeLng: r.geocodeLng ?? null,
      }));
    });

  // §3.4 Coverage / Payers tab: the patient's insurance coverages, ranked (1 = primary). `payer_id`
  // names an M40 canonical Payer — the display NAME is resolved on the client via the MDM client/seam
  // (no cross-module schema import here). RLS scopes by app.org_id; 404 (null) when the patient is
  // absent / out of org (§7.5 no-leak), mirroring listAddresses. Active coverages first, then by rank.
  const listPayers = async (
    organizationId: string,
    patientId: string,
  ): Promise<PatientPayerView[] | null> =>
    withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const exists = await tx.select({ id: P.id }).from(P).where(eq(P.id, patientId)).limit(1);
      if (!exists[0]) return null;
      const rows = await tx
        .select({
          id: PAYER.id,
          payerId: PAYER.payerId,
          rank: PAYER.rank,
          coverageKind: PAYER.coverageKind,
          subscriberId: PAYER.subscriberId,
          groupNumber: PAYER.groupNumber,
          binPcn: PAYER.binPcn,
          effectiveFrom: PAYER.effectiveFrom,
          effectiveTo: PAYER.effectiveTo,
        })
        .from(PAYER)
        .where(eq(PAYER.patientId, patientId))
        // active first (effective_to NULLS FIRST via the boolean), then by rank ascending.
        .orderBy(asc(PAYER.effectiveTo), asc(PAYER.rank));
      return rows.map((r) => ({
        id: r.id,
        payerId: r.payerId,
        rank: r.rank,
        coverageKind: r.coverageKind,
        subscriberId: r.subscriberId,
        groupNumber: r.groupNumber ?? null,
        binPcn: r.binPcn ?? null,
        current: r.effectiveTo === null,
        effectiveFrom: r.effectiveFrom,
        effectiveTo: r.effectiveTo ?? null,
      }));
    });

  const addPayer = async (
    organizationId: string,
    patientId: string,
    input: AddPatientPayerInput,
    actorUserId: string,
  ): Promise<PatientPayerView> =>
    withOrgContext(
      db,
      {
        organizationId,
        userId: actorUserId,
      },
      async (tx) => {
        /*
         * Fail closed if the patient does not belong to the current
         * organization / is not visible under RLS.
         */
        const [patient] = await tx
          .select({
            id: P.id,
          })
          .from(P)
          .where(eq(P.id, patientId))
          .limit(1);

        if (!patient) {
          throw new Error(`patient ${patientId} not found`);
        }

        /*
         * patient_payer has a partial unique index:
         *
         *   (patient_id, rank)
         *   WHERE effective_to IS NULL
         *
         * Close the existing current coverage occupying this rank
         * before inserting its replacement.
         *
         * We preserve history rather than updating the old coverage
         * in place.
         */
        await tx
          .update(PAYER)
          .set({
            effectiveTo: input.effectiveFrom,
          })
          .where(
            and(
              eq(PAYER.patientId, patientId),
              eq(PAYER.rank, input.rank),
              isNull(PAYER.effectiveTo),
            ),
          );

        const [inserted] = await tx
          .insert(PAYER)
          .values({
            organizationId,
            patientId,

            payerId: input.payerId,

            rank: input.rank,

            coverageKind: input.coverageKind as typeof PAYER.$inferInsert.coverageKind,

            subscriberId: input.subscriberId,

            groupNumber: input.groupNumber ?? null,

            binPcn: input.binPcn ?? null,

            effectiveFrom: input.effectiveFrom,

            effectiveTo: null,
          })
          .returning({
            id: PAYER.id,
            payerId: PAYER.payerId,
            rank: PAYER.rank,
            coverageKind: PAYER.coverageKind,
            subscriberId: PAYER.subscriberId,
            groupNumber: PAYER.groupNumber,
            binPcn: PAYER.binPcn,
            effectiveFrom: PAYER.effectiveFrom,
            effectiveTo: PAYER.effectiveTo,
          });

        if (!inserted) {
          throw new Error("patient payer insert failed");
        }

        await emitPatientEvent(tx, organizationId, patientId, "m5.patient.payer_changed");

        return {
          id: inserted.id,
          payerId: inserted.payerId,
          rank: inserted.rank,
          coverageKind: inserted.coverageKind,
          subscriberId: inserted.subscriberId,
          groupNumber: inserted.groupNumber ?? null,
          binPcn: inserted.binPcn ?? null,
          current: inserted.effectiveTo === null,
          effectiveFrom: inserted.effectiveFrom,
          effectiveTo: inserted.effectiveTo ?? null,
        };
      },
    );

  // §3.4/§3.5 Care Team & Assignments tab: the clinical assignment roster (`patient_assignment`) +
  // the caregiver involvements (`patient_caregiver` ⨝ `caregiver`) + the emergency contacts. Each is
  // an M5-owned read under RLS (app.org_id). The assignment's clinician is returned as a bare
  // `clinicianUserId` — the staff NAME crosses into M2, so the client resolves it through the M2
  // roster (no cross-module schema import here), mirroring the §3.4 payer → M40 client-edge resolution.
  // 404 (null) when the patient is absent / out of org (§7.5 no-leak), like listAddresses/listPayers.
  const getCareTeam = async (
    organizationId: string,
    patientId: string,
  ): Promise<CareTeamView | null> =>
    withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const exists = await tx.select({ id: P.id }).from(P).where(eq(P.id, patientId)).limit(1);
      if (!exists[0]) return null;

      const assignmentRows = await tx
        .select({
          id: ASSIGN.id,
          clinicianUserId: ASSIGN.clinicianUserId,
          role: ASSIGN.role,
          assignedAt: ASSIGN.assignedAt,
          unassignedAt: ASSIGN.unassignedAt,
        })
        .from(ASSIGN)
        .where(eq(ASSIGN.patientId, patientId))
        // active first (unassigned_at NULLS FIRST via the boolean), then newest assignment.
        .orderBy(asc(ASSIGN.unassignedAt), desc(ASSIGN.assignedAt));

      const caregiverRows = await tx
        .select({
          id: PCG.id,
          caregiverId: PCG.caregiverId,
          firstName: CG.firstName,
          lastName: CG.lastName,
          phone: CG.phone,
          email: CG.email,
          relationship: PCG.relationship,
          isPrimary: PCG.isPrimary,
          isLegalRepresentative: PCG.isLegalRepresentative,
          lrAuthority: PCG.lrAuthority,
          involvementTo: PCG.involvementTo,
        })
        .from(PCG)
        .innerJoin(CG, eq(CG.id, PCG.caregiverId))
        .where(eq(PCG.patientId, patientId))
        // current first (involvement_to NULLS FIRST), then primary, then by relationship.
        .orderBy(asc(PCG.involvementTo), desc(PCG.isPrimary), asc(PCG.relationship));

      const contactRows = await tx
        .select({
          id: EC.id,
          name: EC.name,
          relationship: EC.relationship,
          phone: EC.phone,
          email: EC.email,
          priority: EC.priority,
        })
        .from(EC)
        .where(eq(EC.patientId, patientId))
        .orderBy(asc(EC.priority));

      return {
        assignments: assignmentRows.map((r) => ({
          id: r.id,
          clinicianUserId: r.clinicianUserId,
          role: r.role,
          assignedAt: r.assignedAt,
          unassignedAt: r.unassignedAt ?? null,
          current: r.unassignedAt === null,
        })),
        caregivers: caregiverRows.map((r) => ({
          id: r.id,
          caregiverId: r.caregiverId,
          firstName: r.firstName,
          lastName: r.lastName,
          relationship: r.relationship,
          isPrimary: r.isPrimary,
          isLegalRepresentative: r.isLegalRepresentative,
          lrAuthority: r.lrAuthority,
          phone: r.phone ?? null,
          email: r.email ?? null,
          current: r.involvementTo === null,
        })),
        emergencyContacts: contactRows.map((r) => ({
          id: r.id,
          name: r.name,
          relationship: r.relationship,
          phone: r.phone,
          email: r.email ?? null,
          priority: r.priority,
        })),
      };
    });

  const createAssignment = async (
    organizationId: string,
    patientId: string,
    input: CreatePatientAssignmentInput,
    _actorUserId: string,
  ): Promise<AssignmentView> =>
    withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const [patient] = await tx.select({ id: P.id }).from(P).where(eq(P.id, patientId)).limit(1);
      if (!patient) throw new WardenXError("NOT_FOUND", "patient not found", 404);
      const [membership] = await tx
        .select({ userId: MEM.userId, status: MEM.status })
        .from(MEM)
        .where(eq(MEM.id, input.clinicianMembershipId))
        .limit(1);
      if (!membership || membership.status !== "active")
        throw new WardenXError(
          "CLINICIAN_MEMBERSHIP_INVALID",
          "The selected clinician is not an active member of this organization.",
          422,
        );
      const duplicate = await tx
        .select({ id: ASSIGN.id })
        .from(ASSIGN)
        .where(
          and(
            eq(ASSIGN.patientId, patientId),
            eq(ASSIGN.clinicianUserId, membership.userId),
            eq(ASSIGN.role, input.role as never),
            isNull(ASSIGN.unassignedAt),
          ),
        )
        .limit(1);
      if (duplicate[0])
        throw new WardenXError(
          "ACTIVE_ASSIGNMENT_EXISTS",
          "This clinician already has this active care team role.",
          409,
        );
      const [row] = await tx
        .insert(ASSIGN)
        .values({
          patientId,
          organizationId,
          clinicianUserId: membership.userId,
          role: input.role as never,
          assignedAt: input.assignedAt ?? new Date().toISOString().slice(0, 10),
        })
        .returning();
      if (!row) throw new Error("patient assignment insert failed");
      await outbox.publish(tx as DbClient, {
        eventName: "m5.patient.assignment_created",
        payload: { organizationId, patientId, clinicianUserId: row.clinicianUserId },
        organizationId,
        aggregateKind: "patient_assignment",
        aggregateId: row.id,
      });
      return {
        id: row.id,
        clinicianUserId: row.clinicianUserId,
        role: row.role,
        assignedAt: row.assignedAt,
        unassignedAt: null,
        current: true,
      };
    });

  const endAssignment = async (
    organizationId: string,
    patientId: string,
    assignmentId: string,
    _actorUserId: string,
  ): Promise<AssignmentView> =>
    withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const [row] = await tx
        .select()
        .from(ASSIGN)
        .where(and(eq(ASSIGN.id, assignmentId), eq(ASSIGN.patientId, patientId)))
        .limit(1);
      if (!row) throw new WardenXError("NOT_FOUND", "care team assignment not found", 404);
      if (row.unassignedAt)
        throw new WardenXError(
          "ASSIGNMENT_ALREADY_ENDED",
          "This care team assignment has already ended.",
          409,
        );
      const [ended] = await tx
        .update(ASSIGN)
        .set({ unassignedAt: new Date().toISOString().slice(0, 10) })
        .where(eq(ASSIGN.id, assignmentId))
        .returning();
      if (!ended) throw new Error("patient assignment end failed");
      await outbox.publish(tx as DbClient, {
        eventName: "m5.patient.assignment_ended",
        payload: { organizationId, patientId, clinicianUserId: ended.clinicianUserId },
        organizationId,
        aggregateKind: "patient_assignment",
        aggregateId: ended.id,
      });
      return {
        id: ended.id,
        clinicianUserId: ended.clinicianUserId,
        role: ended.role,
        assignedAt: ended.assignedAt,
        unassignedAt: ended.unassignedAt,
        current: false,
      };
    });

  // §3.5 / D10 Privacy Flags tab: the patient's active privacy RESTRICTIONS, read from the
  // denormalized `patient_privacy_flag_snapshot` (recomputed from M39 `m39.consent.*` — at most one
  // live row per patient, `invalidated_at IS NULL`). A flag present = restricted. The §7.6 SUD read
  // gate is decided by the M5 privacy engine (`isSudReadAllowed`) — FAIL-CLOSED: a SUD-flagged patient
  // is non-disclosable here (the snapshot's flag is the source until the M39 consent-present signal is
  // wired live). RLS scopes by app.org_id; 404 (null) when the patient is absent / out of org
  // (§7.5 no-leak), mirroring listAddresses/listPayers/getCareTeam.
  const getPrivacyFlags = async (
    organizationId: string,
    patientId: string,
  ): Promise<PrivacyFlagsView | null> =>
    withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const exists = await tx.select({ id: P.id }).from(P).where(eq(P.id, patientId)).limit(1);
      if (!exists[0]) return null;
      const rows = await tx
        .select({ flags: PFS.flags, capturedAt: PFS.capturedAt, invalidatedAt: PFS.invalidatedAt })
        .from(PFS)
        .where(and(eq(PFS.patientId, patientId), isNull(PFS.invalidatedAt)))
        .limit(1);
      const snapshot = rows[0];
      const flags = snapshot?.flags ?? [];
      // §7.6 fail-closed: no separate consent-present signal at this layer, so the snapshot flag IS the
      // source — a SUD-restricted patient is non-disclosable (`isSudReadAllowed(flags, false)`).
      const sudDisclosable = isSudReadAllowed(flags as readonly PrivacyFlag[], false);
      return {
        flags,
        capturedAt: snapshot?.capturedAt ? snapshot.capturedAt.toISOString() : null,
        sudRestricted: flags.includes("sud"),
        sudDisclosable,
      };
    });

  // §7.4 / D5: append a patient address (US addresses require a state — patient_address CHECK) + report
  // the address-change cascade event. An `isPrimary` add performs ATOMIC primary rotation in one tx:
  // close the prior current primary (set effective_to so the partial unique index frees up), then
  // insert the new current primary. `m5.patient.address_changed` is published in the same transaction, so
  // `cascadeEmitted` is only returned when the event was really enqueued (a publish failure rolls back).
  // A write keyed by a patient id must see that patient under the caller's org (RLS). The child tables'
  // policies only compare their own organization_id, so without this a caller could attach a row — and
  // publish an event — for another tenant's patient id.
  const assertPatientVisible = async (tx: Tx, patientId: string): Promise<void> => {
    const found = (await tx
      .select({ id: P.id })
      .from(P)
      .where(eq(P.id, patientId))
      .limit(1)) as Array<{
      id: string;
    }>;
    if (!found[0]) throw new NotFoundError("patient");
  };

  const addAddress = async (
    organizationId: string,
    patientId: string,
    address: AddAddressInput,
    actorUserId: string,
  ): Promise<{ addressId: string; cascadeEmitted: "m5.patient.address_changed" }> =>
    withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
      await assertPatientVisible(tx, patientId);
      const today = new Date().toISOString().slice(0, 10);
      if (address.isPrimary) {
        await tx
          .update(ADDR)
          .set({ effectiveTo: today })
          .where(
            and(eq(ADDR.patientId, patientId), eq(ADDR.isPrimary, true), isNull(ADDR.effectiveTo)),
          );
      }
      const inserted = (await tx
        .insert(ADDR)
        .values({
          organizationId,
          patientId,
          kind: (address.kind ?? "home") as typeof ADDR.$inferInsert.kind,
          line1: address.line1,
          line2: address.line2 ?? null,
          city: address.city,
          state: address.state ?? null,
          postalCode: address.postalCode,
          isPrimary: address.isPrimary ?? false,
          effectiveFrom: today,
        })
        .returning({ addressId: ADDR.id })) as Array<{ addressId: string }>;
      const addressId = inserted[0]!.addressId;
      await emitPatientEvent(tx, organizationId, patientId, "m5.patient.address_changed", {
        addressId,
      });
      return { addressId, cascadeEmitted: "m5.patient.address_changed" };
    });

  // §7.7: open a record-amendment request; SLA due = received + 60 days. The §4.x body captures
  // scope + rationale only, so requested_changes is an empty object until the schema carries it.
  const submitAmendment = async (
    organizationId: string,
    patientId: string,
    input: { scope: string; rationale: string },
    actorUserId: string,
  ) =>
    withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
      await assertPatientVisible(tx, patientId);
      const slaDueAt = new Date(Date.now() + SIXTY_DAYS_MS);
      const inserted = (await tx
        .insert(schema.patientAmendmentRequests)
        .values({
          organizationId,
          patientId,
          requestedByUserId: actorUserId,
          scope: input.scope,
          requestedChanges: {},
          rationale: input.rationale,
          status: "pending",
          slaDueAt,
        })
        .returning({
          id: schema.patientAmendmentRequests.id,
          slaDueAt: schema.patientAmendmentRequests.slaDueAt,
        })) as Array<{ id: string; slaDueAt: Date }>;
      await emitPatientEvent(
        tx,
        organizationId,
        patientId,
        "m5.patient.amendment_request_received",
        { amendmentId: inserted[0]!.id },
      );
      return {
        id: inserted[0]!.id,
        patientId,
        status: "pending" as const,
        slaDueAt: inserted[0]!.slaDueAt.toISOString(),
      };
    });

  // §7.7: accept/deny an amendment (a denial requires a reason).
  const decideAmendment = async (
    organizationId: string,
    amendmentId: string,
    decision: { accept: boolean; denialReason?: string },
    actorUserId: string,
  ) =>
    withOrgContext(db, { organizationId, userId: actorUserId }, async (tx) => {
      if (!decision.accept && !decision.denialReason) throw new Error("denial requires a reason");
      const rows = (await tx
        .select({
          patientId: schema.patientAmendmentRequests.patientId,
          slaDueAt: schema.patientAmendmentRequests.slaDueAt,
        })
        .from(schema.patientAmendmentRequests)
        .where(eq(schema.patientAmendmentRequests.id, amendmentId))
        .limit(1)) as Array<{ patientId: string; slaDueAt: Date }>;
      const row = rows[0];
      if (!row) throw new Error(`amendment ${amendmentId} not found`);
      const status = decision.accept ? ("accepted" as const) : ("denied" as const);
      await tx
        .update(schema.patientAmendmentRequests)
        .set({
          status,
          denialReason: decision.denialReason ?? null,
          reviewerUserId: actorUserId || null,
          decidedAt: new Date(),
        })
        .where(eq(schema.patientAmendmentRequests.id, amendmentId));
      await emitPatientEvent(tx, organizationId, row.patientId, "m5.patient.amendment_decided", {
        amendmentId,
        decision: status,
      });
      return {
        id: amendmentId,
        patientId: row.patientId,
        status,
        slaDueAt: row.slaDueAt.toISOString(),
      };
    });

  // `writes` (in-memory) is no longer needed — all writes are real now.

  return {
    list,
    censusMetrics,
    getPatient,
    getDemographics,
    getIdentifiers,
    listAddresses,
    listPayers,
    addPayer,
    getCareTeam,
    createAssignment,
    endAssignment,
    getPrivacyFlags,
    admit,
    addAddress,
    submitAmendment,
    decideAmendment,
  };
}
