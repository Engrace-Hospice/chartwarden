// apps/backend/src/modules/05-patient/wristband-verifier.ts -- M5 `PatientWristbandVerifier` seam impl (GAP-020).
//
// Answers ONE question for M13's BCMA `wrong_patient` arm: "is the wristband that was just scanned this patient's
// current band?". The scan arrives as the RAW payload; it is parsed, hashed (org-salted) and looked up by digest.
// Only a VERDICT crosses the seam -- no token, no digest comparand -- so M13 never holds identity material.
//
// The verdict is decided by a pure function over a small store port (unit-testable without a database); the
// Drizzle store reads under `withOrgContext` (RLS scopes it, the explicit organization_id is the belt).
//
// FAIL CLOSED everywhere: an unknown token is never `verified`; a patient that is unreadable under the caller's
// org (unknown / cross-tenant) is `not_on_file`; a voided generation never verifies, online or offline.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  OFFLINE_WRISTBAND_MAX_AGE_MS,
  type PatientWristbandVerifier,
  type WristbandVerdict,
  parseWristbandPayload,
} from "@chartwarden/types";
import { and, eq, sql } from "drizzle-orm";
import { wristbandDigest } from "./wristband-digest";

/** The empty-acting-user sentinel the other seam readers use (the M4 audit trigger maps "" to NULL). */
const WRISTBAND_VERIFIER_SYSTEM_USER_ID = "";

/** The slice of one `patient_wristband` row the verdict needs. */
export interface WristbandRow {
  readonly patientId: string;
  readonly generation: number;
  readonly issuedAt: Date;
  readonly supersededAt: Date | null;
  readonly voidedAt: Date | null;
}

/** The data port the verifier decides over. */
export interface WristbandVerifierStore {
  /** Is the patient visible under the caller's org (unknown / cross-tenant = false)? */
  patientReadable(organizationId: string, patientId: string): Promise<boolean>;
  /** Does the patient have any generation, and an ACTIVE one (neither superseded nor voided)? */
  patientState(
    organizationId: string,
    patientId: string,
  ): Promise<{ readonly hasAny: boolean; readonly hasActive: boolean }>;
  /** The generation whose digest equals `digest` (any patient, this org), or null. */
  findByDigest(organizationId: string, digest: string): Promise<WristbandRow | null>;
}

const verdict = (
  status: WristbandVerdict["status"],
  extra: Partial<Omit<WristbandVerdict, "status">> = {},
): WristbandVerdict => ({
  status,
  generation: extra.generation ?? null,
  scannedDigest: extra.scannedDigest ?? null,
  matchedPatientId: extra.matchedPatientId ?? null,
});

/** May a SUPERSEDED (never voided) band still verify for an offline capture scanned at `asOfMs`? */
function withinOfflineGrace(row: WristbandRow, asOfMs: number, nowMs: number): boolean {
  if (row.supersededAt === null) return false;
  if (asOfMs > nowMs) return false; // a device clock in the future cannot resurrect a dead band
  return (
    asOfMs >= row.issuedAt.getTime() &&
    asOfMs <= row.supersededAt.getTime() &&
    nowMs - asOfMs <= OFFLINE_WRISTBAND_MAX_AGE_MS
  );
}

export function createWristbandVerifier(
  store: WristbandVerifierStore,
  now: () => Date = () => new Date(),
): PatientWristbandVerifier {
  return {
    async verify({ organizationId, patientId, payload, asOf, mode }) {
      if (!(await store.patientReadable(organizationId, patientId))) return verdict("not_on_file");

      if (payload === null) {
        const state = await store.patientState(organizationId, patientId);
        return verdict(state.hasActive ? "not_presented" : "not_on_file");
      }

      const parsed = parseWristbandPayload(payload);
      if (!parsed.ok) return verdict("malformed");

      const scannedDigest = wristbandDigest(organizationId, parsed.token);
      const row = await store.findByDigest(organizationId, scannedDigest);
      if (row === null) {
        const state = await store.patientState(organizationId, patientId);
        return verdict(state.hasAny ? "mismatch" : "not_on_file", { scannedDigest });
      }
      const matched = { generation: row.generation, scannedDigest };
      if (row.patientId !== patientId)
        return verdict("mismatch", { ...matched, matchedPatientId: row.patientId });
      if (row.voidedAt !== null) return verdict("voided", matched);
      if (row.supersededAt === null) return verdict("verified", matched);

      const asOfMs = Date.parse(asOf);
      const graceApplies =
        mode === "offline_sync" &&
        Number.isFinite(asOfMs) &&
        withinOfflineGrace(row, asOfMs, now().getTime());
      return verdict(graceApplies ? "verified" : "superseded", matched);
    },
  };
}

/** The Drizzle-backed store. Every read runs inside `withOrgContext` so RLS scopes it to the caller's org. */
export function createDrizzleWristbandVerifierStore(db: DbClient): WristbandVerifierStore {
  const P = schema.patients;
  const W = schema.patientWristbands;
  const read = <T>(organizationId: string, fn: (tx: DbClient) => Promise<T>): Promise<T> =>
    withOrgContext(db, { organizationId, userId: WRISTBAND_VERIFIER_SYSTEM_USER_ID }, (tx) =>
      fn(tx as unknown as DbClient),
    );
  return {
    patientReadable: (organizationId, patientId) =>
      read(organizationId, async (tx) => {
        const [row] = await tx
          .select({ id: P.id })
          .from(P)
          .where(and(eq(P.organizationId, organizationId), eq(P.id, patientId)))
          .limit(1);
        return row !== undefined;
      }),
    patientState: (organizationId, patientId) =>
      read(organizationId, async (tx) => {
        const [row] = await tx
          .select({
            total: sql<number>`count(*)::int`,
            active: sql<number>`count(*) filter (where ${W.supersededAt} is null and ${W.voidedAt} is null)::int`,
          })
          .from(W)
          .where(and(eq(W.organizationId, organizationId), eq(W.patientId, patientId)));
        return { hasAny: (row?.total ?? 0) > 0, hasActive: (row?.active ?? 0) > 0 };
      }),
    findByDigest: (organizationId, digest) =>
      read(organizationId, async (tx) => {
        const [row] = await tx
          .select({
            patientId: W.patientId,
            generation: W.generation,
            issuedAt: W.issuedAt,
            supersededAt: W.supersededAt,
            voidedAt: W.voidedAt,
          })
          .from(W)
          .where(and(eq(W.organizationId, organizationId), eq(W.payloadDigest, digest)))
          .limit(1);
        return row ?? null;
      }),
  };
}

export function buildPatientWristbandVerifier(db: DbClient): PatientWristbandVerifier {
  return createWristbandVerifier(createDrizzleWristbandVerifierStore(db));
}
