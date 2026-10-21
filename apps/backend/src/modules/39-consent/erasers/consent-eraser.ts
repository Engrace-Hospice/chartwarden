// apps/backend/src/modules/39-consent/erasers/consent-eraser.ts — M39-T10 (spec §3.8, D20).
//
// M39's REAL `consent` DataEraser, registered over the Phase-0 deny-stub. The M4 destruction-cert
// workflow hands `subjectId` = the patient whose retention class reached eligible_for_destruction;
// the eraser deletes that patient's consent subtree EXCEPT rows it must retain (§3.8): an active
// legal hold (M4 §10.6) or a `42_cfr_part_2_release` while the patient is still alive (Part 2
// lifetime retention). consent_eval_audit is never touched here — its destruction is M4's certified
// audit-retention path (M39-F04). The decision engine is the pure `eraseConsentForSubject`
// (@chartwarden/consent); this is the thin DataEraser shell over an injected store (in-memory by default).
import {
  type ConsentEraseStore,
  type ConsentSubjectSummary,
  createInMemoryConsentEraseStore,
  eraseConsentForSubject,
} from "@chartwarden/consent";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { DataEraser } from "@chartwarden/types";
import { and, eq, inArray, or } from "drizzle-orm";
import { registerEraser } from "../../../bootstrap/index";

/**
 * The Drizzle-backed {@link ConsentEraseStore}: the REAL destruction path (ARCH-007 bind). The
 * legal-hold + 42 CFR Part 2 lifetime REFUSALS live in the pure `eraseConsentForSubject` engine —
 * this store only (a) reports the facts those decisions need and (b) executes the deletes the engine
 * allowed. Every statement runs inside `withOrgContext` so RLS scopes it to the acting org.
 *
 * Fact reporting (`consentSummary`):
 *   • `patientDeceased` — the M5 spine's `status = 'deceased'`. A MISSING patient row reports
 *     `false` (fail-closed toward RETENTION: if we cannot prove the Part 2 lifetime has ended, the
 *     `42_cfr_part_2_release` rows are refused, never destroyed).
 *   • `legalHold` — an ACTIVE `legal_hold` whose jsonb `criteria` references the patient id or the
 *     consent record id marks the row held (M4 §10.6 supremacy; criteria carries references/filters,
 *     so id containment is the match). Over-matching only ever RETAINS — the safe direction.
 *
 * Delete execution (`deleteConsents`):
 *   • Every id is verified to belong to the subject patient first; a foreign id THROWS
 *     (`M39_ERASER_FOREIGN_CONSENT_ID`) rather than silently skipping — the engine and the store
 *     disagreeing about the subject is a bug, not a partial success.
 *   • Children first (all RESTRICT-FKs): delegated_access (it also FKs the recipient) →
 *     document_link → expiration_reminder → dpoa_agent → recipient → revocation → renewal_cycle
 *     (matched on source OR resolved record) → the `consent_record` rows in ONE statement (immediate
 *     FK checks run at statement end, so intra-set supersession/renewal/acting self-FK chains are
 *     legal). A RETAINED record still FK-pointing at a deleted one makes that DELETE throw — the
 *     store never mutates a retained record's chain to force a delete through.
 *   • The returned count is rows ACTUALLY deleted (`.returning()` across record + subtree), never
 *     the input length. `consent_eval_audit` is untouched (M4's certified audit-retention path).
 */
export function createDrizzleConsentEraseStore(db: DbClient): ConsentEraseStore {
  const REC = schema.consentRecord;
  const RCPT = schema.consentRecordRecipient;
  const DPOA = schema.consentRecordDpoaAgent;
  const REVOC = schema.consentRevocation;
  const REMIND = schema.consentExpirationReminder;
  const CYCLE = schema.consentRenewalCycle;
  const DELEG = schema.delegatedAccess;
  const DOCLINK = schema.consentDocumentLink;
  const HOLD = schema.legalHolds;
  const P = schema.patients;

  return {
    async consentSummary(organizationId, patientId): Promise<ConsentSubjectSummary> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const records = await tx
          .select({ id: REC.id, typeKey: REC.typeKey })
          .from(REC)
          .where(eq(REC.patientId, patientId));

        // Fail-closed deceased proof: only a live 'deceased' status row ends the Part 2 lifetime.
        const patientRows = await tx
          .select({ status: P.status })
          .from(P)
          .where(eq(P.id, patientId));
        const patientDeceased = patientRows[0]?.status === "deceased";

        // Active legal holds whose criteria reference the subject (or one of its records).
        const holds = records.length
          ? await tx.select({ criteria: HOLD.criteria }).from(HOLD).where(eq(HOLD.status, "active"))
          : [];
        const holdTexts = holds.map((h) => JSON.stringify(h.criteria ?? {}));
        const held = (recordId: string): boolean =>
          holdTexts.some((t) => t.includes(patientId) || t.includes(recordId));

        return {
          patientDeceased,
          rows: records.map((r) => ({ id: r.id, typeKey: r.typeKey, legalHold: held(r.id) })),
        };
      });
    },

    async deleteConsents(organizationId, patientId, consentRecordIds) {
      if (consentRecordIds.length === 0) return 0;
      const ids = [...consentRecordIds];
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        // Refusal: every id the engine allowed must belong to THIS subject in THIS org — a foreign
        // id means engine/store drift, and executing it would erase another patient's consents.
        const verified = await tx
          .select({ id: REC.id })
          .from(REC)
          .where(and(inArray(REC.id, ids), eq(REC.patientId, patientId)));
        if (verified.length !== ids.length) {
          throw new Error(
            `M39_ERASER_FOREIGN_CONSENT_ID: ${ids.length - verified.length} of ${ids.length} ids do not belong to the subject patient`,
          );
        }

        const del = async <T extends { id: string }>(run: () => Promise<T[]>): Promise<number> =>
          (await run()).length;

        // Children first — every satellite RESTRICT-FKs the record (delegated_access also FKs the
        // recipient row, so it precedes the recipient delete).
        const delegated = await del(() =>
          tx.delete(DELEG).where(inArray(DELEG.consentRecordId, ids)).returning({ id: DELEG.id }),
        );
        const docLinks = await del(() =>
          tx
            .delete(DOCLINK)
            .where(inArray(DOCLINK.consentRecordId, ids))
            // consent_document_link has a composite PK (no surrogate id) — count on the FK column.
            .returning({ id: DOCLINK.consentRecordId }),
        );
        const reminders = await del(() =>
          tx
            .delete(REMIND)
            .where(inArray(REMIND.consentRecordId, ids))
            .returning({ id: REMIND.id }),
        );
        const dpoaAgents = await del(() =>
          tx.delete(DPOA).where(inArray(DPOA.consentRecordId, ids)).returning({ id: DPOA.id }),
        );
        const recipients = await del(() =>
          tx.delete(RCPT).where(inArray(RCPT.consentRecordId, ids)).returning({ id: RCPT.id }),
        );
        const revocations = await del(() =>
          tx.delete(REVOC).where(inArray(REVOC.consentRecordId, ids)).returning({ id: REVOC.id }),
        );
        // A renewal cycle FKs the record twice (source + resolved) — either edge pins it.
        const cycles = await del(() =>
          tx
            .delete(CYCLE)
            .where(
              or(
                inArray(CYCLE.sourceConsentRecordId, ids),
                inArray(CYCLE.resolvedConsentRecordId, ids),
              ),
            )
            .returning({ id: CYCLE.id }),
        );
        // One statement so intra-set self-FK chains (supersede/renewal/acting) delete cleanly.
        const recordsDeleted = await del(() =>
          tx
            .delete(REC)
            .where(and(inArray(REC.id, ids), eq(REC.patientId, patientId)))
            .returning({ id: REC.id }),
        );

        return (
          delegated +
          docLinks +
          reminders +
          dpoaAgents +
          recipients +
          revocations +
          cycles +
          recordsDeleted
        );
      });
    },
  };
}

/** Injected adapter for M39's eraser (slice defaults to the in-memory erase store). */
export interface ConsentEraserDeps {
  /** The data port deletes run over (Drizzle-backed in production; in-memory by default). */
  store?: ConsentEraseStore;
}

/** Build M39's `consent` DataEraser. Returns the count actually deleted; rows retained under a legal
 *  hold or the Part 2 lifetime are NOT counted (mirrors M4's audit-eraser refusal accounting). */
export function createConsentEraser(store: ConsentEraseStore): DataEraser {
  return {
    async erase(scope, subjectId) {
      const { erased, retained } = await eraseConsentForSubject(scope.orgId, subjectId, store);
      return {
        erased,
        refusedPartTwo: retained["42_cfr_part_2_release"] ?? 0,
        refusedLegalHold: retained.consent_held_by_legal_hold ?? 0,
      };
    },
  };
}

/** Register M39's REAL `consent` eraser into the M1 destruction-cert registry over the Phase-0
 *  deny-stub (M39-T10). Called by the composition root's wireModuleErasers() before validateErasers(). */
export function registerConsentErasers(deps: ConsentEraserDeps = {}): void {
  const store = deps.store ?? createInMemoryConsentEraseStore().store;
  registerEraser("consent", createConsentEraser(store));
}
