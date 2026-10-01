// apps/backend/src/modules/14-idg/erasers/idg-eraser.ts — M14-T07 the `idg_record` data eraser (M14 spec §8.4;
// M4 destruction-cert workflow).
//
// M14 owns the destruction callback for a patient's IDG subtree — the patient-scoped artifacts M14 captures
// around the M5 patient spine. Under an M4 destruction certificate it (1) acquires a per-patient advisory lock
// so a concurrent write cannot interleave with the destruction, then (2) erases the patient's
// `idg_patient_packet` rows (the per-patient packet snapshots), the patient's `idg_decision` rows, the patient's
// `idg_action_item` rows, and the patient's `idg_agenda_item` rows — every IDG row that carries a `patient_id`.
//
// What SURVIVES (§8.4): the `idg_meeting`, `idg_recurring_policy`, `idg_attendance`, `idg_minutes`, and
// `idg_minutes_amendment` rows. A meeting is a caseload-wide / location-level artifact, not a single patient's
// record — erasing it would destroy the regulatory record of the whole team's review. Patient-specific
// references inside the `idg_minutes` `*_snapshot` jsonb are HASH-REDACTED via the M4 trigger pattern (the same
// approach M5's `clinical_record` and the minutes audit-trigger use), NOT deleted by this callback. Unlike
// M10's HOPE eraser there is no CMS extended-retention block — IDG records carry M4's standard `compliance`
// retention class, enforced by the certificate's `retentionAsOf` boundary, not by this callback (§8.4).
//
// Registers the REAL eraser over the Phase-0 deny-stub (`idg_record` is in REQUIRED_ERASERS); the composition
// root's wireModuleErasers() invokes it AFTER wireErasers() (deny-stubs) and before validateErasers(), so a real
// eraser stands over its stub.
import { createHash } from "node:crypto";
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { DataEraser } from "@wardenx/types";
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { registerEraser } from "../../../bootstrap/index";

/** The per-table counts an IDG-record destruction removed (recorded on the destruction cert, §8.4). */
export interface IdgEraseCounts {
  /** `idg_patient_packet` rows deleted for the patient. */
  readonly packets: number;
  /** `idg_decision` rows deleted for the patient (patient-scoped decisions only). */
  readonly decisions: number;
  /** `idg_action_item` rows deleted for the patient (patient-scoped action items only). */
  readonly actionItems: number;
  /** `idg_agenda_item` rows deleted for the patient (patient-scoped agenda entries only). */
  readonly agendaItems: number;
  /** `idg_discipline_note` rows deleted for the patient (patient-scoped notes only; meeting-level notes survive). */
  readonly disciplineNotes: number;
  /** `idg_minutes` rows whose patient-specific snapshot references were hash-redacted (rows NOT deleted, §8.4). */
  readonly minutesRedacted: number;
}

/** Knobs the M4 destruction cert carries into the erase (defaults: erase everything up to now). */
export interface IdgEraseOptions {
  /** Erase rows older than `retentionAsOf`; defaults to {@link IdgEraseOptions.now}'s instant. */
  readonly retentionAsOf?: string;
  /** Clock injection (tests pin it); defaults to the system clock. */
  readonly now?: () => string;
}

/** The narrow data port the IDG eraseFn composes over (Drizzle deletes in prod, under RLS). */
export interface IdgEraseStore {
  /**
   * Acquire a per-patient advisory lock (keyed on patient id) so a concurrent write cannot interleave with the
   * destruction. Released by the surrounding transaction commit in prod; a no-op in the slice.
   */
  lockPatient(organizationId: string, patientId: string): Promise<void>;
  /**
   * Erase the patient's IDG subtree: the `idg_patient_packet` / `idg_decision` / `idg_action_item` /
   * `idg_agenda_item` rows carrying the patient's id (`*.created_at < retentionAsOf`), and hash-redact the
   * patient-specific references inside the `idg_minutes` snapshots (rows preserved). The caseload-wide
   * `idg_meeting` / `idg_recurring_policy` / `idg_attendance` / `idg_minutes` / `idg_minutes_amendment` rows are
   * left intact (§8.4). Returns counts.
   */
  erasePatientRecords(
    organizationId: string,
    patientId: string,
    retentionAsOf: string,
  ): Promise<IdgEraseCounts>;
}

/**
 * Erase a patient's IDG subtree under a destruction certificate (§8.4): lock the patient, then delete the
 * patient-scoped packet / decision / action-item / agenda rows (and hash-redact minutes references) and report
 * the total removed. Pure orchestration over the store — no I/O of its own. The caseload-wide meeting / policy /
 * attendance / minutes rows are never deleted (§8.4).
 */
export async function eraseIdgRecord(
  organizationId: string,
  patientId: string,
  store: IdgEraseStore,
  options: IdgEraseOptions = {},
): Promise<{ erased: number; counts: IdgEraseCounts }> {
  const now = options.now ?? (() => new Date().toISOString());
  const retentionAsOf = options.retentionAsOf ?? now();

  await store.lockPatient(organizationId, patientId);

  const counts = await store.erasePatientRecords(organizationId, patientId, retentionAsOf);
  // minutesRedacted is bookkeeping (rows redacted-in-place, not deleted) — excluded from the deleted-row tally.
  const erased =
    counts.packets +
    counts.decisions +
    counts.actionItems +
    counts.agendaItems +
    counts.disciplineNotes;
  return { erased, counts };
}

/** Seed shape for the in-memory {@link IdgEraseStore} (slice/tests). */
export interface InMemoryIdgEraseSeed {
  /** Per-table counts a first erase removes. */
  readonly counts?: Partial<IdgEraseCounts>;
}

/** An in-memory {@link IdgEraseStore} for the slice/tests (seeded counts; idempotent on a second erase). */
export function createInMemoryIdgEraseStore(seed: InMemoryIdgEraseSeed = {}): {
  store: IdgEraseStore;
  locked: string[];
} {
  const zero: IdgEraseCounts = {
    packets: 0,
    decisions: 0,
    actionItems: 0,
    agendaItems: 0,
    disciplineNotes: 0,
    minutesRedacted: 0,
  };
  const counts: IdgEraseCounts = { ...zero, ...seed.counts };
  const locked: string[] = [];
  let used = false;
  return {
    locked,
    store: {
      async lockPatient(_org, patientId) {
        locked.push(patientId);
      },
      async erasePatientRecords() {
        // idempotent: a second erase removes nothing (rows already gone).
        const out = used ? zero : counts;
        used = true;
        return out;
      },
    },
  };
}

/**
 * The Drizzle-backed store: the REAL destruction path. Runs inside `withOrgContext` so RLS scopes every
 * statement to the acting org (a destruction certificate can never reach across tenants). Deletes ONLY
 * the patient-scoped rows (`patient_id = subject`, `created_at < retentionAsOf`; the partitioned
 * `idg_patient_packet` via its partition-key predicate `built_at < retentionAsOf`) — the caseload-wide
 * `idg_meeting` / `idg_recurring_policy` / `idg_attendance` / `idg_minutes` / `idg_minutes_amendment`
 * rows SURVIVE (§8.4). Patient references inside the surviving `idg_minutes` `*_snapshot` jsonb are
 * HASH-REDACTED in place (the patient uuid is replaced by its sha256 — the M4 hash-redaction pattern),
 * so the frozen minutes stay structurally intact without naming the destroyed patient. Any statement
 * the database refuses THROWS and rolls the erase back — the erase never reports success it did not
 * perform.
 */
export function createDrizzleIdgEraseStore(db: DbClient): IdgEraseStore {
  const AGENDA = schema.idgAgendaItem;
  const NOTE = schema.idgDisciplineNote;
  const DEC = schema.idgDecision;
  const ACT = schema.idgActionItem;
  const PKT = schema.idgPatientPacket;
  const MIN = schema.idgMinutes;

  return {
    async lockPatient(organizationId, patientId) {
      await withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        // Advisory lock on the patient key, released by the surrounding transaction commit.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${patientId}))`);
      });
    },

    async erasePatientRecords(organizationId, patientId, retentionAsOf) {
      if (Number.isNaN(Date.parse(retentionAsOf))) {
        throw new Error(`M14_ERASER_BAD_RETENTION_BOUNDARY: ${retentionAsOf}`);
      }
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const boundary = new Date(retentionAsOf);
        const del = async <T extends { id: string }>(run: () => Promise<T[]>): Promise<number> =>
          (await run()).length;
        const ids = (rows: Array<{ id: string }>): string[] => rows.map((r) => r.id);

        // Collect the target row ids (and the meetings they hang off) BEFORE deleting anything: the
        // minutes redaction and the FK detach both need them after the rows are gone.
        const agendaRows = await tx
          .select({ id: AGENDA.id, meetingId: AGENDA.idgMeetingId })
          .from(AGENDA)
          .where(and(eq(AGENDA.patientId, patientId), lt(AGENDA.createdAt, boundary)));
        const decisionRows = await tx
          .select({ id: DEC.id, meetingId: DEC.idgMeetingId })
          .from(DEC)
          .where(and(eq(DEC.patientId, patientId), lt(DEC.createdAt, boundary)));
        const actionRows = await tx
          .select({ id: ACT.id, meetingId: ACT.idgMeetingId })
          .from(ACT)
          .where(and(eq(ACT.patientId, patientId), lt(ACT.createdAt, boundary)));
        const noteRows = await tx
          .select({ id: NOTE.id, meetingId: NOTE.idgMeetingId })
          .from(NOTE)
          .where(and(eq(NOTE.patientId, patientId), lt(NOTE.createdAt, boundary)));
        const packetRows = await tx
          .select({ id: PKT.id, meetingId: PKT.idgMeetingId })
          .from(PKT)
          .where(and(eq(PKT.patientId, patientId), lt(PKT.builtAt, boundary)));
        const meetingIds = [
          ...new Set(
            [...agendaRows, ...decisionRows, ...actionRows, ...noteRows, ...packetRows].map(
              (r) => r.meetingId,
            ),
          ),
        ];

        // FK order: idg_action_item → idg_decision → idg_agenda_item (action items FK the decision,
        // decisions FK the agenda item). Non-patient rows are never deleted, but a surviving team-level
        // row may still REFERENCE a deleted patient row — those references are detached (nulled), which
        // removes the last pointer at the destroyed record without touching the survivor's own content.
        const actionItems =
          actionRows.length === 0
            ? 0
            : await del(() =>
                tx
                  .delete(ACT)
                  .where(inArray(ACT.id, ids(actionRows)))
                  .returning({ id: ACT.id }),
              );
        if (decisionRows.length > 0) {
          await tx
            .update(ACT)
            .set({ idgDecisionId: null })
            .where(inArray(ACT.idgDecisionId, ids(decisionRows)));
        }
        const decisions =
          decisionRows.length === 0
            ? 0
            : await del(() =>
                tx
                  .delete(DEC)
                  .where(inArray(DEC.id, ids(decisionRows)))
                  .returning({ id: DEC.id }),
              );
        if (agendaRows.length > 0) {
          await tx
            .update(DEC)
            .set({ agendaItemId: null })
            .where(inArray(DEC.agendaItemId, ids(agendaRows)));
        }
        const agendaItems =
          agendaRows.length === 0
            ? 0
            : await del(() =>
                tx
                  .delete(AGENDA)
                  .where(inArray(AGENDA.id, ids(agendaRows)))
                  .returning({ id: AGENDA.id }),
              );

        // Patient-scoped discipline notes (free-text PHI): plain delete — nothing references them.
        const disciplineNotes =
          noteRows.length === 0
            ? 0
            : await del(() =>
                tx
                  .delete(NOTE)
                  .where(inArray(NOTE.id, ids(noteRows)))
                  .returning({ id: NOTE.id }),
              );

        // The partitioned packet parent, via the partition-key predicate (row-delete; DETACH+DROP is a
        // DDL maintenance path the RLS-scoped app role cannot run).
        const packets = await del(() =>
          tx
            .delete(PKT)
            .where(and(eq(PKT.patientId, patientId), lt(PKT.builtAt, boundary)))
            .returning({ id: PKT.id }),
        );

        // Hash-redact the patient references inside the surviving minutes snapshots (rows PRESERVED,
        // §8.4): every occurrence of the patient uuid inside the three `*_snapshot` jsonb columns is
        // replaced by its sha256 hex — valid JSON stays valid, the meeting record stays whole, the
        // patient is no longer nameable from it. Counts only the minutes that actually contained the id.
        const patientDigest = createHash("sha256").update(patientId).digest("hex");
        const needle = `%${patientId}%`;
        const redact = (col: AnyPgColumn) =>
          sql`replace(${col}::text, ${patientId}, ${patientDigest})::jsonb`;
        const minutesRedacted =
          meetingIds.length === 0
            ? 0
            : (
                await tx
                  .update(MIN)
                  .set({
                    attendanceSnapshot: redact(MIN.attendanceSnapshot),
                    decisionListSnapshot: redact(MIN.decisionListSnapshot),
                    actionItemListSnapshot: redact(MIN.actionItemListSnapshot),
                    disciplineNoteSnapshot: redact(MIN.disciplineNoteSnapshot),
                  })
                  .where(
                    and(
                      inArray(MIN.idgMeetingId, meetingIds),
                      or(
                        sql`${MIN.attendanceSnapshot}::text LIKE ${needle}`,
                        sql`${MIN.decisionListSnapshot}::text LIKE ${needle}`,
                        sql`${MIN.actionItemListSnapshot}::text LIKE ${needle}`,
                        sql`${MIN.disciplineNoteSnapshot}::text LIKE ${needle}`,
                      ),
                    ),
                  )
                  .returning({ id: MIN.id })
              ).length;

        return { packets, decisions, actionItems, agendaItems, disciplineNotes, minutesRedacted };
      });
    },
  };
}

/** Injected adapter for the M14 eraser (slice defaults to in-memory). */
export interface IdgEraserDeps {
  store?: IdgEraseStore;
  /** Bound from the M4 destruction certificate in prod; the slice keeps the conservative defaults. */
  options?: IdgEraseOptions;
}

/** Build M14's `idg_record` DataEraser. `subjectId` is the patient being destroyed (§8.4). */
export function createIdgEraser(store: IdgEraseStore, options: IdgEraseOptions = {}): DataEraser {
  return {
    async erase(scope, subjectId) {
      const { erased } = await eraseIdgRecord(scope.orgId, subjectId, store, options);
      return { erased };
    },
  };
}

/** Register M14's REAL `idg_record` eraser over the Phase-0 deny-stub (M14-T07; before validateErasers()). */
export function registerIdgErasers(deps: IdgEraserDeps = {}): void {
  const store = deps.store ?? createInMemoryIdgEraseStore().store;
  registerEraser("idg_record", createIdgEraser(store, deps.options ?? {}));
}
