// apps/backend/src/modules/05-patient — PRODUCTION PatientRouteService, READ-first (M5 §4.2).
//
// The census + chart-resolve READS (list / getPatient) run on a real Drizzle query over the M5-owned
// `patient` table inside withOrgContext, so RLS scopes by app.org_id. The census fields (mrn, legal
// name, dob, status) are PLAINTEXT on `patient` (mrn is denormalised there for exactly this hot path;
// only ssn/state_id/mbi are envelope-encrypted, on `patient_identifier`) — so no per-row decryption.
//
// ADMIT is now real: the §7.1 matcher runs against the org's existing patients and a no-block result
// inserts the `patient` row (+ its mrn/mbi identifiers) under RLS — so an admitted patient appears in
// the real census. addAddress / amendments still run on the in-memory service (not shown in the census;
// their Drizzle stores are a follow-up), as are SSN/name-alias/address storage on admit.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { type SQL, and, asc, eq, ilike, or, sql } from "drizzle-orm";
import { type MatchCandidate, runMatch } from "./matching/matcher";
import { normalizeSubject } from "./matching/normalize";
import { createInMemoryPatientRouteService } from "./routes/service";
import type { AdmitInput, AdmitResult, PatientRouteService, PatientView } from "./routes/service";

const ID = schema.patientIdentifiers;

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

function toView(r: { id: string; organizationId: string; mrn: string; lastName: string; firstName: string; dob: string; status: string }): PatientView {
  return { id: r.id, organizationId: r.organizationId, mrn: r.mrn, lastName: r.lastName, firstName: r.firstName, dob: r.dob, status: r.status };
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

/** Build the read-backed PatientRouteService; writes delegate to the in-memory slice (follow-up). */
export function createDbPatientRouteService(db: DbClient): PatientRouteService {
  const writes = createInMemoryPatientRouteService().service;

  const list = async (organizationId: string, query: ListQuery) => {
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(query.limit ?? DEFAULT_LIMIT)));
    const c = query.cursor ? decode(query.cursor) : null;
    const where = and(
      query.status ? eq(P.status, query.status as typeof P.$inferSelect.status) : undefined,
      query.q
        ? (or(
            ilike(P.legalLastName, `%${query.q}%`),
            ilike(P.legalFirstName, `%${query.q}%`),
            ilike(P.mrn, `%${query.q}%`),
          ) as SQL)
        : undefined,
      // ascending (lastName, firstName, id) strictly after the cursor row
      c ? (sql`(${P.legalLastName}, ${P.legalFirstName}, ${P.id}) > (${c[0]}, ${c[1]}, ${c[2]}::uuid)` as SQL) : undefined,
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

  const getPatient = async (organizationId: string, id: string): Promise<PatientView | null> =>
    withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const rows = await tx.select(VIEW_COLUMNS).from(P).where(eq(P.id, id)).limit(1);
      return rows[0] ? toView(rows[0]) : null;
    });

  // Insert the patient row (+ its mrn / mbi identifiers) — the census reads patient.mrn (denormalised),
  // patient_identifier is the source of truth. SSN is NOT stored here (envelope-encrypted; a follow-up),
  // nor are name_alias / address / phone / email (also follow-ups). Returns the new patient id.
  type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
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
    await tx.insert(ID).values({ patientId, organizationId, kind: "mrn", value: mrn, effectiveFrom: today });
    if (input.mbi) {
      await tx.insert(ID).values({ patientId, organizationId, kind: "mbi", value: input.mbi, effectiveFrom: today });
    }
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
          .select({ id: P.id, lastName: P.legalLastName, firstName: P.legalFirstName, dob: P.dob, mbi: ID.value })
          .from(P)
          .leftJoin(ID, and(eq(ID.patientId, P.id), eq(ID.kind, "mbi")));
        const candidates: MatchCandidate[] = candRows.map((r) => ({
          ...normalizeSubject({ lastName: r.lastName, firstName: r.firstName, dob: r.dob, mbi: r.mbi }),
          id: r.id,
        }));
        const result = runMatch(incoming, candidates);
        if (result.outcome === "hard_block") {
          return { outcome: "hard_block", existingPatientId: result.existingPatientId, matchedOn: String(result.matchedOn) };
        }
        const patientId = await insertPatient(tx, organizationId, input);
        // soft_review match-review rows (patient_match_review) are a follow-up — return no ids for now.
        if (result.outcome === "soft_review") return { outcome: "soft_review", patientId, matchReviewIds: [] };
        return { outcome: "created", patientId };
      }
      return { outcome: "created", patientId: await insertPatient(tx, organizationId, input) };
    });

  return {
    list,
    getPatient,
    admit,
    // Still in-memory until their Drizzle stores land: address/amendments (not shown in the census).
    addAddress: writes.addAddress.bind(writes),
    submitAmendment: writes.submitAmendment.bind(writes),
    decideAmendment: writes.decideAmendment.bind(writes),
  };
}
