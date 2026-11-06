// apps/backend/src/modules/16-bereavement/routes/letter-service-drizzle.ts — the Drizzle-backed physician letter service
// (ADR-0109 D6, routes 38 / 39 / 40).
//
// Approve and decline run the pure `decideLetterApproval` / `decideLetterDecline` rules inside one `withOrgContext` transaction with an
// optimistic `If-Match` version check and a compare-and-set UPDATE, so two reviewers cannot both decide one letter. Approval emits
// `m16.bereavement.document_requested` through the catalog-validating publisher on the SAME transaction: the status change and the
// render request commit together or not at all. The reviewer's personal note is sealed with the tenant DEK BEFORE the transaction opens
// (the key provider takes its own connection, the M21-T05 self-deadlock); with no cipher bound a note is refused 503 rather than
// stored in plaintext. A user the reviewer names as the recipient must hold an ACTIVE membership in this organization: the letter stays
// internal. The render payload carries the death date and the note and no name.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { NotFoundError } from "@chartwarden/types";
import { and, asc, eq, gt, or } from "drizzle-orm";
import type { BereavementCipher } from "../bereavement-crypto";
import {
  BereavementStateError,
  checkVersion,
  decideLetterApproval,
  decideLetterDecline,
  normalizePersonalNote,
} from "../lifecycle/index";
import type { M16ReadActor, M16WriteActor } from "./actor";
import { type Cursor, M16_PAGE_SIZES, clampLimit, decodeCursor, toCursorPage } from "./concurrency";
import type { M16LetterService, PhysicianLetterView } from "./letter-service";
import type { WriteOutboxPort } from "./write-service";

/** The M22 template the approved letter renders through, and the document kind the event names. */
export const PHYSICIAN_CONDOLENCE_TEMPLATE_KEY = "bereavement_physician_condolence_letter";
export const PHYSICIAN_CONDOLENCE_DOCUMENT_KIND = "physician_condolence_letter";

export interface M16LetterDeps {
  /** The catalog-validating tx publisher (callerModule `m16`). */
  readonly outbox: WriteOutboxPort;
  /** The tenant-DEK envelope the note is sealed with. Unbound => a request that carries a note is refused 503. */
  readonly cipher?: BereavementCipher;
  /** Clock injection (tests pin it). */
  readonly now?: () => Date;
}

type LetterRow = typeof schema.bereavementPhysicianLetter.$inferSelect;

const iso = (d: Date): string => d.toISOString();

function viewOf(row: LetterRow): PhysicianLetterView {
  return {
    letterId: row.id,
    planId: row.planId,
    patientId: row.patientId,
    status: row.status,
    dueAt: iso(row.dueAt),
    createdAt: iso(row.createdAt),
    attendingUserId: row.attendingUserId ?? null,
    hasPersonalNote: row.personalNoteCipher !== null,
    declineReason: row.declineReasonRedacted ?? null,
    reviewedAt: row.reviewedAt ? iso(row.reviewedAt) : null,
    renderedDocumentId: row.renderedDocumentId ?? null,
    version: row.version,
  };
}

const staleVersion = (): BereavementStateError =>
  new BereavementStateError("STALE_VERSION", "the letter has moved on; re-read it and retry");

export function buildDrizzleM16LetterService(db: DbClient, deps: M16LetterDeps): M16LetterService {
  const LETTER = schema.bereavementPhysicianLetter;
  const PLAN = schema.bereavementPlan;
  const MEMBERSHIP = schema.memberships;
  const now = deps.now ?? (() => new Date());
  const scope = (actor: M16ReadActor) => ({
    organizationId: actor.organizationId,
    userId: actor.userId,
  });

  async function letterOr404(tx: DbClient, letterId: string): Promise<LetterRow> {
    const [row] = await tx.select().from(LETTER).where(eq(LETTER.id, letterId)).limit(1);
    if (!row) {
      throw new BereavementStateError("PHYSICIAN_LETTER_NOT_FOUND", "physician letter not found");
    }
    return row;
  }

  return {
    async listLetters(actor, input) {
      const limit = clampLimit(input.limit, M16_PAGE_SIZES.plans);
      const after: Cursor | null = decodeCursor(input.cursor);
      return withOrgContext(db, scope(actor), async (scoped) => {
        const tx = scoped as unknown as DbClient;
        const dueAfter = after === null ? undefined : new Date(after.a);
        const rows = await tx
          .select()
          .from(LETTER)
          .where(
            and(
              input.status === undefined ? undefined : eq(LETTER.status, input.status),
              after === null || dueAfter === undefined
                ? undefined
                : or(
                    gt(LETTER.dueAt, dueAfter),
                    and(eq(LETTER.dueAt, dueAfter), gt(LETTER.id, after.id)),
                  ),
            ),
          )
          .orderBy(asc(LETTER.dueAt), asc(LETTER.id))
          .limit(limit + 1);
        return toCursorPage(rows, limit, (row) => ({ a: iso(row.dueAt), id: row.id }), viewOf);
      });
    },

    async getLetterForPlan(actor, planId) {
      return withOrgContext(db, scope(actor), async (scoped) => {
        const tx = scoped as unknown as DbClient;
        const [row] = await tx.select().from(LETTER).where(eq(LETTER.planId, planId)).limit(1);
        return row ? viewOf(row) : null;
      });
    },

    async approveLetter(actor: M16WriteActor, letterId, input) {
      const note = normalizePersonalNote(input.personalNote);
      if (note !== null && deps.cipher === undefined) {
        throw new BereavementStateError(
          "PHYSICIAN_LETTER_NOTE_STORAGE_UNAVAILABLE",
          "personal notes cannot be stored: no tenant key is bound",
        );
      }
      const sealed =
        note === null || deps.cipher === undefined
          ? null
          : await deps.cipher.encrypt(
              actor.organizationId,
              "bereavement_physician_letter.personal_note",
              note,
            );

      return withOrgContext(db, scope(actor), async (scoped) => {
        const tx = scoped as unknown as DbClient;
        const letter = await letterOr404(tx, letterId);
        checkVersion(input.expectedVersion, letter.version);
        const decision = decideLetterApproval(
          { status: letter.status, attendingUserId: letter.attendingUserId ?? null },
          { personalNote: note, attendingUserId: input.attendingUserId },
        );
        if (decision.attendingUserId !== letter.attendingUserId) {
          // The reviewer named the recipient: it must be an active member of THIS organization (RLS scopes the read).
          const [member] = await tx
            .select({ id: MEMBERSHIP.id })
            .from(MEMBERSHIP)
            .where(
              and(
                eq(MEMBERSHIP.userId, decision.attendingUserId),
                eq(MEMBERSHIP.organizationId, actor.organizationId),
                eq(MEMBERSHIP.status, "active"),
              ),
            )
            .limit(1);
          if (!member) {
            throw new BereavementStateError(
              "PHYSICIAN_LETTER_ATTENDING_INVALID",
              "the chosen recipient is not an active member of this organization",
            );
          }
        }
        const [plan] = await tx
          .select({ deathDate: PLAN.deathDate })
          .from(PLAN)
          .where(eq(PLAN.id, letter.planId))
          .limit(1);
        if (!plan) throw new NotFoundError("bereavement plan not found");

        const at = now();
        const [row] = await tx
          .update(LETTER)
          .set({
            status: "approved",
            attendingUserId: decision.attendingUserId,
            personalNoteCipher: sealed,
            reviewedByMembershipId: actor.membershipId,
            reviewedAt: at,
            m22RenderRequestedAt: at,
            version: letter.version + 1,
            updatedAt: at,
          })
          .where(
            and(
              eq(LETTER.id, letter.id),
              eq(LETTER.version, letter.version),
              eq(LETTER.status, "pending_review"),
            ),
          )
          .returning();
        if (!row) throw staleVersion();

        await deps.outbox.publish(tx, {
          organizationId: actor.organizationId,
          eventName: "m16.bereavement.document_requested",
          aggregateKind: "bereavement_physician_letter",
          aggregateId: row.id,
          payload: {
            planId: row.planId,
            patientId: row.patientId,
            documentKind: PHYSICIAN_CONDOLENCE_DOCUMENT_KIND,
            aggregateId: row.id,
            templateKey: PHYSICIAN_CONDOLENCE_TEMPLATE_KEY,
            payloadJsonb: { deathDate: plan.deathDate, personalNote: decision.personalNote },
          },
        });
        return viewOf(row);
      });
    },

    async declineLetter(actor: M16WriteActor, letterId, input) {
      return withOrgContext(db, scope(actor), async (scoped) => {
        const tx = scoped as unknown as DbClient;
        const letter = await letterOr404(tx, letterId);
        checkVersion(input.expectedVersion, letter.version);
        const reason = decideLetterDecline({ status: letter.status }, input.reason);
        const at = now();
        const [row] = await tx
          .update(LETTER)
          .set({
            status: "declined",
            declineReasonRedacted: reason,
            reviewedByMembershipId: actor.membershipId,
            reviewedAt: at,
            version: letter.version + 1,
            updatedAt: at,
          })
          .where(
            and(
              eq(LETTER.id, letter.id),
              eq(LETTER.version, letter.version),
              eq(LETTER.status, "pending_review"),
            ),
          )
          .returning();
        if (!row) throw staleVersion();
        return viewOf(row);
      });
    },
  };
}
