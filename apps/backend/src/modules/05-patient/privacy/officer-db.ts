// apps/backend/src/modules/05-patient/privacy/officer-db.ts — the Drizzle Privacy Officer service behind
// `GET /patients/:id/privacy`, `POST /patients/:id/privacy-flags/resync` and
// `GET /privacy/restricted-patients` (M5 §4.2 / §5.1; the pure decisions live in `./officer.ts`).
//
// Reads and the resync write run under `withOrgContext`, so RLS scopes every row to the caller's org and
// another tenant's patient is a 404. The resync runs as the ACTING user, so the M4 write trigger on
// `patient_privacy_flag_snapshot` attributes the change to the officer (that trail is the page's
// timeline). `m5.patient.privacy_flag_changed` is emitted in the same transaction, only when the flag set
// changed — the event's own meaning (M5 §4.6). The per-patient re-derivation (`rederivePrivacySnapshot`) is
// shared with the quarterly `patient.snapshot_rebuild` job (§4.5, `../jobs/snapshot-rebuild.ts`), which runs
// it org-explicitly as the system and writes only drifted rows.
import type { Static } from "@sinclair/typebox";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { type SQL, and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { M5OutboxPort } from "../deceased-db";
import type {
  PatientPrivacyViewSchema,
  PrivacyResyncResponseSchema,
  RestrictedPatientsQuerySchema,
  RestrictedPatientsResponseSchema,
} from "../routes/privacy-typebox";
import {
  type PrivacyFlagOrigin,
  type PrivacyOfficerPorts,
  type ResyncDecision,
  type SnapshotFacts,
  batchContributes,
  decideResync,
  detectDrift,
  flagSinceFromHistory,
  originOf,
  snapshotNeedsWrite,
} from "./officer";

export type PatientPrivacyView = Static<typeof PatientPrivacyViewSchema>;
export type PrivacyResyncResult = Static<typeof PrivacyResyncResponseSchema>;
export type RestrictedPatientsQuery = Static<typeof RestrictedPatientsQuerySchema>;
export type RestrictedPatientsPage = Static<typeof RestrictedPatientsResponseSchema>;

export interface PrivacyOfficerService {
  getPatientPrivacy(organizationId: string, patientId: string): Promise<PatientPrivacyView | null>;
  resync(
    organizationId: string,
    patientId: string,
    actorUserId: string,
  ): Promise<PrivacyResyncResult | null>;
  listRestricted(
    organizationId: string,
    query: RestrictedPatientsQuery,
  ): Promise<RestrictedPatientsPage>;
}

const P = schema.patients;
const PFS = schema.patientPrivacyFlagSnapshots;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

const displayNameOf = (r: { legalFirstName: string; legalLastName: string }): string =>
  `${r.legalLastName}, ${r.legalFirstName}`;

function factsOf(row: {
  flags: string[];
  sudFlagOrigin: string | null;
  sourceConsentVersion: string | null;
  capturedAt: Date;
  invalidatedAt: Date | null;
}): SnapshotFacts {
  return {
    flags: row.flags,
    sudFlagOrigin: row.sudFlagOrigin,
    sourceConsentVersion: row.sourceConsentVersion,
    capturedAt: row.capturedAt.toISOString(),
    invalidatedAt: iso(row.invalidatedAt),
  };
}

const flagsIn = (row: Record<string, unknown> | null): string[] =>
  row && Array.isArray(row.flags)
    ? (row.flags as unknown[]).filter((f): f is string => typeof f === "string")
    : [];

/** The SQL predicate selecting snapshot rows of one queue origin (mirrors `originOf`). */
function originWhere(origin: PrivacyFlagOrigin | "stale"): SQL {
  const hasSud = sql`'sud' = ANY(${PFS.flags})`;
  switch (origin) {
    case "stale":
      return isNotNull(PFS.invalidatedAt);
    case "intake_unconfirmed":
      return and(hasSud, eq(PFS.sudFlagOrigin, "m22_intake_unconfirmed")) as SQL;
    case "intake_confirmed":
      return and(hasSud, eq(PFS.sudFlagOrigin, "m22_intake_confirmed")) as SQL;
    case "consent":
      return and(hasSud, isNull(PFS.sudFlagOrigin), isNotNull(PFS.sourceConsentVersion)) as SQL;
    case "unattributed":
      return sql`NOT (${hasSud} AND (${PFS.sudFlagOrigin} IS NOT NULL OR ${PFS.sourceConsentVersion} IS NOT NULL))`;
  }
}

async function loadPatient(tx: DbClient, patientId: string) {
  const [p] = await tx
    .select({
      id: P.id,
      mrn: P.mrn,
      status: P.status,
      legalFirstName: P.legalFirstName,
      legalLastName: P.legalLastName,
    })
    .from(P)
    .where(eq(P.id, patientId))
    .limit(1);
  return p ?? null;
}

async function loadSnapshot(tx: DbClient, patientId: string, forUpdate = false) {
  const q = tx
    .select({
      flags: PFS.flags,
      sudFlagOrigin: PFS.sudFlagOrigin,
      sourceConsentVersion: PFS.sourceConsentVersion,
      capturedAt: PFS.capturedAt,
      invalidatedAt: PFS.invalidatedAt,
    })
    .from(PFS)
    .where(eq(PFS.patientId, patientId))
    .limit(1);
  const [row] = forUpdate ? await q.for("update") : await q;
  return row ?? null;
}

/** What one re-derivation of a patient's snapshot did. */
export interface PrivacySnapshotRederivation {
  readonly patientId: string;
  /** The snapshot's flags before (sorted; empty when no row existed). */
  readonly flagsBefore: string[];
  readonly decision: ResyncDecision;
  /** Whether a snapshot row existed before. */
  readonly existed: boolean;
  /** Whether the row was stale (`invalidated_at` set) before. */
  readonly wasStale: boolean;
  /** Whether the row was written (always for a resync; only on drift for the rebuild). */
  readonly written: boolean;
  /** Whether `m5.patient.privacy_flag_changed` was emitted (only when the flag SET changed). */
  readonly eventEmitted: boolean;
  readonly capturedAt: string;
}

/**
 * Re-derive ONE patient's `patient_privacy_flag_snapshot` from its sources — the single derivation the
 * officer's resync (§4.2) and the quarterly rebuild (§4.5 `patient.snapshot_rebuild`) share. ORG-EXPLICIT
 * (a cron tick is not a request): the source reads go through the M39/M22 ports, each in its own
 * org-scoped transaction; the decision (`decideResync` — never lifts a DocLens flag while M39 is silent),
 * the upsert and the `m5.patient.privacy_flag_changed` emit are one `withOrgContext` transaction, run as
 * `actorUserId` (the officer for a resync, `""` — audited as system — for the job). With
 * `onlyWhenDrifted`, an unchanged non-stale snapshot is left untouched (no write, no M4 audit row).
 * Returns null when the patient is not visible in the org (RLS: another tenant's patient).
 */
export async function rederivePrivacySnapshot(
  db: DbClient,
  outbox: M5OutboxPort,
  ports: Pick<PrivacyOfficerPorts, "consent" | "intake">,
  input: {
    readonly organizationId: string;
    readonly patientId: string;
    readonly actorUserId: string;
    readonly onlyWhenDrifted: boolean;
    readonly now?: Date;
  },
): Promise<PrivacySnapshotRederivation | null> {
  const { organizationId, patientId, actorUserId } = input;
  if (!UUID.test(patientId)) return null;
  // The source reads run first, each under its own org-scoped transaction (they are other modules'
  // tables, reached through their ports); the decision and the write are one transaction.
  const exists = await withOrgContext(db, { organizationId, userId: "" }, async (scoped) =>
    loadPatient(scoped as unknown as DbClient, patientId),
  );
  if (!exists) return null;
  const [consent, batches] = await Promise.all([
    ports.consent.part2ConsentState(organizationId, patientId),
    ports.intake.sudBatchesForPatient(organizationId, patientId),
  ]);
  return withOrgContext(db, { organizationId, userId: actorUserId }, async (scoped) => {
    const tx = scoped as unknown as DbClient;
    if (!(await loadPatient(tx, patientId))) return null;
    const row = await loadSnapshot(tx, patientId, true);
    const current = row ? factsOf(row) : null;
    const decision = decideResync(current, consent, batches);
    const now = input.now ?? new Date();
    const written = !input.onlyWhenDrifted || snapshotNeedsWrite(current, decision);
    if (written) {
      const values = {
        flags: [...decision.flags],
        capturedAt: now,
        sudFlagOrigin: decision.sudFlagOrigin,
        sourceConsentVersion: decision.sourceConsentVersion,
        invalidatedAt: null,
      };
      await tx
        .insert(PFS)
        .values({ patientId, organizationId, ...values })
        .onConflictDoUpdate({ target: PFS.patientId, set: values });
    }
    const eventEmitted = written && decision.flagsChanged;
    if (eventEmitted) {
      await outbox.publish(tx, {
        eventName: "m5.patient.privacy_flag_changed",
        payload: { patientId, organizationId, flags: [...decision.flags] },
        organizationId,
        aggregateKind: "patient",
        aggregateId: patientId,
      });
    }
    return {
      patientId,
      flagsBefore: [...(current?.flags ?? [])].sort(),
      decision,
      existed: row !== null,
      wasStale: row?.invalidatedAt != null,
      written,
      eventEmitted,
      capturedAt: (written ? now : (row?.capturedAt ?? now)).toISOString(),
    };
  });
}

export function createDbPrivacyOfficerService(
  db: DbClient,
  outbox: M5OutboxPort,
  ports: PrivacyOfficerPorts,
): PrivacyOfficerService {
  return {
    async getPatientPrivacy(organizationId, patientId) {
      if (!UUID.test(patientId)) return null;
      const local = await withOrgContext(db, { organizationId, userId: "" }, async (scoped) => {
        const tx = scoped as unknown as DbClient;
        const patient = await loadPatient(tx, patientId);
        if (!patient) return null;
        return { patient, snapshot: await loadSnapshot(tx, patientId) };
      });
      if (!local) return null;
      const [consent, batches, history] = await Promise.all([
        ports.consent.part2ConsentState(organizationId, patientId),
        ports.intake.sudBatchesForPatient(organizationId, patientId),
        ports.history.snapshotHistory(organizationId, patientId),
      ]);
      const snap = local.snapshot ? factsOf(local.snapshot) : null;
      const since = flagSinceFromHistory(history);
      const flags = [...(snap?.flags ?? [])].sort();
      return {
        patient: {
          id: local.patient.id,
          displayName: displayNameOf(local.patient),
          mrn: local.patient.mrn,
          status: String(local.patient.status),
        },
        snapshot: {
          exists: snap !== null,
          flags,
          capturedAt: snap?.capturedAt ?? null,
          stale: snap?.invalidatedAt != null,
          invalidatedAt: snap?.invalidatedAt ?? null,
          sourceConsentVersion: snap?.sourceConsentVersion ?? null,
        },
        restrictions: snap
          ? flags.map((flag) => ({
              flag,
              origin: originOf(flag, snap),
              since: since.get(flag) ?? snap.capturedAt,
              sinceFromHistory: since.has(flag),
            }))
          : [],
        part2Consent: consent,
        intakeDetections: batches.map((b) => ({ ...b, contributes: batchContributes(b) })),
        history: history.map((e) => ({
          at: e.at,
          actorUserId: e.actorUserId,
          action: (e.eventType.endsWith(".insert")
            ? "insert"
            : e.eventType.endsWith(".delete")
              ? "delete"
              : "update") as "insert" | "update" | "delete",
          flagsBefore: flagsIn(e.before),
          flagsAfter: flagsIn(e.after),
          sudOriginAfter:
            e.after && typeof e.after.sud_flag_origin === "string" ? e.after.sud_flag_origin : null,
        })),
        drift: detectDrift(snap, consent, batches),
      };
    },

    async resync(organizationId, patientId, actorUserId) {
      const out = await rederivePrivacySnapshot(db, outbox, ports, {
        organizationId,
        patientId,
        actorUserId,
        onlyWhenDrifted: false,
      });
      if (!out) return null;
      return {
        patientId,
        flagsBefore: out.flagsBefore,
        flagsAfter: [...out.decision.flags],
        sudOriginAfter: out.decision.sudFlagOrigin,
        sourceConsentVersion: out.decision.sourceConsentVersion,
        flagsChanged: out.decision.flagsChanged,
        eventEmitted: out.eventEmitted,
        capturedAt: out.capturedAt,
      };
    },

    async listRestricted(organizationId, query) {
      const limit = query.limit ?? 50;
      const offset = query.cursor && /^\d+$/.test(query.cursor) ? Number(query.cursor) : 0;
      const restricted = sql`(cardinality(${PFS.flags}) > 0 OR ${PFS.invalidatedAt} IS NOT NULL)`;
      return withOrgContext(db, { organizationId, userId: "" }, async (scoped) => {
        const tx = scoped as unknown as DbClient;
        const where = and(restricted, query.origin ? originWhere(query.origin) : undefined);
        const rows = await tx
          .select({
            patientId: PFS.patientId,
            flags: PFS.flags,
            sudFlagOrigin: PFS.sudFlagOrigin,
            sourceConsentVersion: PFS.sourceConsentVersion,
            capturedAt: PFS.capturedAt,
            invalidatedAt: PFS.invalidatedAt,
            mrn: P.mrn,
            legalFirstName: P.legalFirstName,
            legalLastName: P.legalLastName,
          })
          .from(PFS)
          .innerJoin(P, eq(P.id, PFS.patientId))
          .where(where)
          .orderBy(desc(PFS.capturedAt), desc(PFS.patientId))
          .limit(limit + 1)
          .offset(offset);
        const n = (w: SQL) => sql<number>`(count(*) FILTER (WHERE ${w}))::int`;
        const [c] = await tx
          .select({
            total: sql<number>`count(*)::int`,
            consent: n(originWhere("consent")),
            unconfirmed: n(originWhere("intake_unconfirmed")),
            confirmed: n(originWhere("intake_confirmed")),
            unattributed: n(originWhere("unattributed")),
            stale: n(originWhere("stale")),
          })
          .from(PFS)
          .where(restricted);
        const page = rows.slice(0, limit);
        return {
          items: page.map((r) => ({
            patientId: r.patientId,
            displayName: displayNameOf(r),
            mrn: r.mrn,
            flags: [...r.flags].sort(),
            origin: r.flags.includes("sud") ? originOf("sud", factsOf(r)) : "unattributed",
            capturedAt: r.capturedAt.toISOString(),
            stale: r.invalidatedAt !== null,
          })),
          nextCursor: rows.length > limit ? String(offset + limit) : null,
          counts: {
            total: Number(c?.total ?? 0),
            consent: Number(c?.consent ?? 0),
            intake_unconfirmed: Number(c?.unconfirmed ?? 0),
            intake_confirmed: Number(c?.confirmed ?? 0),
            unattributed: Number(c?.unattributed ?? 0),
            stale: Number(c?.stale ?? 0),
          },
        };
      });
    },
  };
}
