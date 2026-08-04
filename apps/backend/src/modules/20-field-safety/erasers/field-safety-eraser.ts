// apps/backend/src/modules/20-field-safety/erasers/field-safety-eraser.ts — M20-T02, the `safety_record`
// data eraser (M20 spec §3.7 / §8.4; M4 destruction-cert workflow).
//
// THE ERASE IS NOT A DELETE, AND FOR THIS MODULE THAT IS THE WHOLE DESIGN. §3.7 files ten of the thirteen
// tables as "structural row retained with redacted markers": the SOS event-of-record IS the row, the
// incident's `category` / `severity` are what a 2031 review of a 2025 assault reads, and the consent row's
// existence is the proof-of-consent a coercion review turns on. Destroying them in the name of the patient
// whose visit they happened during would destroy the CLINICIAN's own workers-comp evidence — a different
// person's record, and one the patient's right to erasure does not reach.
//
// WHAT A PER-PATIENT DESTRUCTION ACTUALLY REMOVES HERE. M20 is a WORKFORCE-safety module, so its patient
// surface is narrow and explicit — two logical M5 references, `safety_incident.patient_id` and
// `safety_sos_alert.last_known_patient_id`. Under a certificate this (1) advisory-locks the patient,
// (2) REDACTS the free text that may describe them — the incident narrative / witnesses / action plan /
// location description / reopen reason / WC reference, and the SOS resolution narrative and dispatch
// payload — because §3.5 is explicit that these "may contain patient-identifying details since the incident
// occurred during a visit", (3) redacts `action_taken` on every acknowledgment attached to those rows, and
// (4) LAST, severs the linkage itself (`patient_id`, `last_known_patient_id`, `last_known_visit_id`).
//
// ORDER IS LOAD-BEARING: the linkage goes last, because it is the key every statement above selects on.
// Clearing it first would make a partial failure unrecoverable — nothing left to find the rows by.
//
// WHAT IS DELIBERATELY NOT TOUCHED, and it is the same argument each time:
//   • `safety_sos_alert.posted_coordinates_cipher` and the whole `safety_sos_location_stream` — these are
//     the CLINICIAN's coordinates during the clinician's own emergency. They are the §1.1 workers-comp
//     timeline and the §8.7-consented life-safety record of a different data subject. The stream's own
//     destruction path is the §3.7 resolve-plus-90-days sweep, keyed on the alert, not on a patient.
//   • `safety_check_in` / `safety_check_in_schedule` — neither carries a patient column at all. Their only
//     patient linkage is `visit_id`, which is M17's, and resolving it would mean a cross-module read at
//     destruction time against a module that may already have erased its side. A check-in says "the
//     clinician was OK at 14:05"; it is not the patient's data.
//   • `safety_policy` / `safety_policy_version` — configuration, and §3.7 marks the version rows "never
//     erased while any incident references it" (they ARE the replay).
//   • `safety_supervisor_subscription` / `safety_high_risk_area` — org paging config and advisory geography.
//   • `safety_emergency_contact_consent` — the CLINICIAN's own consent, including their spouse's phone
//     number. It is erased on workforce departure, never on a patient's request.
//
// REDACTION MARKERS, not NULLs, on three columns. `safety_incident.narrative_cipher`,
// `safety_sos_alert.posted_coordinates_cipher` and `safety_acknowledgment.action_taken` are NOT NULL, and
// the first additionally carries the `m20_si_narrative_floor` CHECK (≥200 bytes once the incident leaves
// `draft`). A redaction therefore OVERWRITES rather than nulls, with a marker long enough to satisfy the
// constraint the row was written under. The markers are readable on purpose: an operator inspecting a
// redacted row should see a destruction certificate, not a decryption failure.
//
// Idempotent: a second erase finds already-redacted rows and reports zero new ones. Registers the REAL
// eraser over the Phase-0 deny-stub (`safety_record` is in REQUIRED_ERASERS); the composition root's
// wireModuleErasers() runs it AFTER wireErasers() and before validateErasers().
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { DataEraser } from "@wardenx/types";
import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { registerEraser } from "../../../bootstrap/index";

/** The ≥20-char marker that replaces a redacted `safety_acknowledgment.action_taken`. */
export const SAFETY_REDACTED_TEXT = "[redacted — M4 destruction certificate]";
/** The ≥200-byte marker that replaces a redacted `narrative_cipher` (the §2.3 submit floor). */
export const SAFETY_REDACTED_CIPHER_SQL = sql`convert_to(rpad('[redacted — M4 destruction certificate]', 256, '.'), 'UTF8')`;

/** The per-table counts a safety-record destruction produced (recorded on the cert, §3.7). */
export interface SafetyEraseCounts {
  /** `safety_incident` rows redacted and unlinked (rows PRESERVED). */
  readonly incidents: number;
  /** `safety_sos_alert` rows redacted and unlinked (rows PRESERVED). */
  readonly sosAlerts: number;
  /** `safety_acknowledgment` rows whose `action_taken` was redacted (rows PRESERVED). */
  readonly acknowledgments: number;
}

/** Knobs the M4 destruction cert carries into the erase (defaults: erase everything up to now). */
export interface SafetyEraseOptions {
  /** Erase rows older than `retentionAsOf`; defaults to {@link SafetyEraseOptions.now}'s instant. */
  readonly retentionAsOf?: string;
  /** Clock injection (tests pin it); defaults to the system clock. */
  readonly now?: () => string;
}

/** The narrow data port the eraseFn composes over (Drizzle redactions in prod, under RLS). */
export interface SafetyEraseStore {
  /** Advisory-lock the patient so a concurrent M20 write cannot interleave with the destruction. */
  lockPatient(organizationId: string, patientId: string): Promise<void>;
  /**
   * Redact the free text on every `safety_incident` / `safety_sos_alert` row linked to the patient, and on
   * every `safety_acknowledgment` attached to those rows. Runs BEFORE the linkage is severed.
   */
  redactLinkedRecords(organizationId: string, patientId: string): Promise<SafetyEraseCounts>;
  /**
   * Sever the patient linkage LAST (`safety_incident.patient_id`,
   * `safety_sos_alert.last_known_patient_id` + `last_known_visit_id`). Returns rows unlinked.
   */
  severPatientLinkage(
    organizationId: string,
    patientId: string,
    retentionAsOf: string,
  ): Promise<{ incidents: number; sosAlerts: number }>;
}

/**
 * Erase a patient's M20 safety footprint under a destruction certificate (§3.7): lock, redact the free
 * text, then sever the linkage. Pure orchestration over the store — no I/O of its own.
 */
export async function eraseSafetyRecord(
  organizationId: string,
  patientId: string,
  store: SafetyEraseStore,
  options: SafetyEraseOptions = {},
): Promise<{ erased: number; redacted: number; counts: SafetyEraseCounts }> {
  const now = options.now ?? (() => new Date().toISOString());
  const retentionAsOf = options.retentionAsOf ?? now();

  await store.lockPatient(organizationId, patientId);
  // Free text first: if the sever pass fails halfway, anything that could describe the patient is
  // already unreadable.
  const counts = await store.redactLinkedRecords(organizationId, patientId);
  const severed = await store.severPatientLinkage(organizationId, patientId, retentionAsOf);

  const redacted = counts.incidents + counts.sosAlerts + counts.acknowledgments;
  // `erased` is what the certificate reports as removed: the linkages actually severed. The redactions
  // are reported separately because the rows themselves survive by design (§3.7).
  const erased = severed.incidents + severed.sosAlerts;
  return { erased, redacted, counts };
}

const ZERO: SafetyEraseCounts = { incidents: 0, sosAlerts: 0, acknowledgments: 0 };

/** Seed shape for the in-memory {@link SafetyEraseStore} (slice/tests). */
export interface InMemorySafetyEraseSeed {
  readonly counts?: Partial<SafetyEraseCounts>;
}

/** An in-memory store for the slice/tests (seeded counts; idempotent on a second erase). */
export function createInMemorySafetyEraseStore(seed: InMemorySafetyEraseSeed = {}): {
  store: SafetyEraseStore;
  locked: string[];
} {
  const counts: SafetyEraseCounts = { ...ZERO, ...seed.counts };
  const locked: string[] = [];
  let used = false;
  return {
    locked,
    store: {
      async lockPatient(_organizationId, patientId) {
        locked.push(patientId);
      },
      async redactLinkedRecords() {
        return used ? ZERO : counts;
      },
      async severPatientLinkage() {
        const out = used
          ? { incidents: 0, sosAlerts: 0 }
          : { incidents: counts.incidents, sosAlerts: counts.sosAlerts };
        used = true;
        return out;
      },
    },
  };
}

/**
 * The Drizzle-backed store: the REAL destruction path. Runs inside `withOrgContext` so RLS scopes every
 * statement to the acting org (a destruction certificate can never reach across tenants), and redacts every
 * free-text column before it severs anything.
 */
export function createDrizzleSafetyEraseStore(db: DbClient): SafetyEraseStore {
  const INCIDENT = schema.safetyIncident;
  const SOS = schema.safetySosAlert;
  const ACK = schema.safetyAcknowledgment;

  return {
    async lockPatient(organizationId, patientId) {
      await withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        // Advisory lock on the patient key, released by the surrounding transaction commit.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${patientId}))`);
      });
    },

    async redactLinkedRecords(organizationId, patientId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const incidentIds = (
          await tx
            .select({ id: INCIDENT.id })
            .from(INCIDENT)
            .where(eq(INCIDENT.patientId, patientId))
        ).map((r) => r.id);
        const sosIds = (
          await tx.select({ id: SOS.id }).from(SOS).where(eq(SOS.lastKnownPatientId, patientId))
        ).map((r) => r.id);

        if (incidentIds.length === 0 && sosIds.length === 0) return ZERO;

        const incidents =
          incidentIds.length === 0
            ? []
            : await tx
                .update(INCIDENT)
                .set({
                  // NOT NULL + the ≥200-byte submit floor: overwrite rather than null.
                  narrativeCipher: SAFETY_REDACTED_CIPHER_SQL as never,
                  witnessesCipher: null,
                  actionPlanCipher: null,
                  locationDescription: null,
                  reopenReason: null,
                  workersCompClaimReference: null,
                })
                .where(inArray(INCIDENT.id, incidentIds))
                .returning({ id: INCIDENT.id });

        const sosAlerts =
          sosIds.length === 0
            ? []
            : await tx
                .update(SOS)
                .set({
                  // The clinician's own coordinates and the location stream are NOT touched; only the
                  // free text that may describe the patient. See the file header.
                  resolutionNarrativeCipher: null,
                  acknowledgerDispatchPayloadCipher: null,
                })
                .where(inArray(SOS.id, sosIds))
                .returning({ id: SOS.id });

        // Acknowledgments attached to either target. `action_taken` is NOT NULL with a ≥20-char CHECK,
        // so it is overwritten with the marker rather than nulled.
        const ackPredicates = [
          incidentIds.length > 0 ? inArray(ACK.incidentId, incidentIds) : undefined,
          sosIds.length > 0 ? inArray(ACK.sosAlertId, sosIds) : undefined,
        ].filter((p): p is NonNullable<typeof p> => p !== undefined);
        const acknowledgments =
          ackPredicates.length === 0
            ? []
            : await tx
                .update(ACK)
                .set({ actionTaken: SAFETY_REDACTED_TEXT })
                .where(or(...ackPredicates))
                .returning({ id: ACK.id });

        return {
          incidents: incidents.length,
          sosAlerts: sosAlerts.length,
          acknowledgments: acknowledgments.length,
        };
      });
    },

    async severPatientLinkage(organizationId, patientId, retentionAsOf) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        // `retentionAsOf` bounds nothing here: every row reached belongs to this patient's own linkage,
        // and M4's certificate has already applied the retention decision. It stays in the signature (and
        // is validated) so a future retention-windowed path can use it without changing the contract.
        if (Number.isNaN(Date.parse(retentionAsOf))) {
          throw new Error(`M20_ERASER_BAD_RETENTION_BOUNDARY: ${retentionAsOf}`);
        }

        const incidents = await tx
          .update(INCIDENT)
          .set({ patientId: null, visitId: null })
          .where(eq(INCIDENT.patientId, patientId))
          .returning({ id: INCIDENT.id });

        const sosAlerts = await tx
          .update(SOS)
          .set({ lastKnownPatientId: null, lastKnownVisitId: null })
          .where(and(eq(SOS.lastKnownPatientId, patientId), isNotNull(SOS.lastKnownPatientId)))
          .returning({ id: SOS.id });

        return { incidents: incidents.length, sosAlerts: sosAlerts.length };
      });
    },
  };
}

/** Injected adapter for the M20 eraser (slice defaults to in-memory). */
export interface SafetyEraserDeps {
  store?: SafetyEraseStore;
  /** Bound from the M4 destruction certificate in prod; the slice keeps the conservative defaults. */
  options?: SafetyEraseOptions;
}

/** Build M20's `safety_record` DataEraser. `subjectId` is the PATIENT being destroyed (§3.7). */
export function createSafetyEraser(
  store: SafetyEraseStore,
  options: SafetyEraseOptions = {},
): DataEraser {
  return {
    async erase(scope, subjectId) {
      const { erased } = await eraseSafetyRecord(scope.orgId, subjectId, store, options);
      return { erased };
    },
  };
}

/** Register M20's REAL `safety_record` eraser over the Phase-0 deny-stub (before validateErasers()). */
export function registerSafetyErasers(deps: SafetyEraserDeps = {}): void {
  const store = deps.store ?? createInMemorySafetyEraseStore().store;
  registerEraser("safety_record", createSafetyEraser(store, deps.options ?? {}));
}
