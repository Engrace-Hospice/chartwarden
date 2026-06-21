// apps/backend/src/modules/05-patient — PRODUCTION PatientRouteService, READ-first (M5 §4.2).
//
// The census + chart-resolve READS (list / getPatient) run on a real Drizzle query over the M5-owned
// `patient` table inside withOrgContext, so RLS scopes by app.org_id. The census fields (mrn, legal
// name, dob, status) are PLAINTEXT on `patient` (mrn is denormalised there for exactly this hot path;
// only ssn/state_id/mbi are envelope-encrypted, on `patient_identifier`) — so no per-row decryption.
//
// PROGRESSIVE WIRING: the WRITE methods (admit / addAddress / amendments) still run on the in-memory
// service — a patient admitted via POST does NOT yet appear in the real census. The Drizzle admission
// store (the §7.1 matcher + multi-table insert) is the follow-up; this PR serves the read screens
// (Patient List/Census + the Patient Chart banner) with real, RLS-scoped data.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { type SQL, and, asc, eq, ilike, or, sql } from "drizzle-orm";
import { createInMemoryPatientRouteService } from "./routes/service";
import type { PatientRouteService, PatientView } from "./routes/service";

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

  return {
    list,
    getPatient,
    // Writes: in-memory until the Drizzle admission store lands (the §7.1 matcher + multi-table insert).
    admit: writes.admit.bind(writes),
    addAddress: writes.addAddress.bind(writes),
    submitAmendment: writes.submitAmendment.bind(writes),
    decideAmendment: writes.decideAmendment.bind(writes),
  };
}
