// apps/backend/src/modules/25-remittance/routes/audit-response-service.ts - the audit response packet (hospice
// ADR/TPE/QIC PRD milestone 7a-2): type the response checklist from the request letter, attach the documents, attest
// that a letter states no due date, a SECOND person's sign-off, and recording the filing with its proof. Every command
// runs under `withOrgContext` (RLS) inside the actor's provider-entity scope.
//
//   - NOTHING here states what a RAC / UPIC / SMRC requires: the checklist is typed, the channel is a label, the due
//     date is a recorded deadline (7a-1) or the explicit "none stated in the request" attestation.
//   - Every packet change moves the request version, so a sign-off made on a stale If-Match is a 409: a reviewer signs
//     off what they saw, never something edited under them.
//   - Attachments obey the appeal enclosure rules (`describeEnclosures`): org-visible, active, the patient of the live
//     claim they are attached to, never 42 CFR Part 2; refusals carry a reason code, never a title.
//   - Filing records a response made OUTSIDE ChartWarden (nothing is transmitted). It freezes an exact manifest, moves
//     the request `in_review -> responded`, writes the submission attempt (born acknowledged: the proof is required
//     here) and emits `m25.audit_response_packet.render_requested` in the same transaction, so M22 files the
//     cover-and-index PDF as the retained copy. Database triggers keep the manifest, the filing facts and the
//     enclosure list immutable afterwards.
//   - The render payload carries the typed checklist labels, deadline labels and document titles (the PDF is rendered
//     FROM it; M22 has no seam to resolve M25's typed packet itself, the ADR and appeal packets work the same way).
//     It lives only in the tenant-RLS `outbox_event` row, the dispatcher logs the event name, row id and the
//     consumer's error text (a schema path, never a value), and the audited columns hold counts and ids only.
//   - A sign-off stores a fingerprint of what was signed off (claims, checklist, documents, deadlines, attestation);
//     filing recomputes it and refuses a packet that moved (AUDIT_SIGNOFF_STALE).
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  ChartWardenError,
  MAX_AUDIT_ENCLOSURES,
  NotFoundError,
  buildAuditResponsePacketRenderPayload,
} from "@chartwarden/types";
import { and, asc, eq, isNull } from "drizzle-orm";
import {
  type AuditFilingChannel,
  type AuditFilingRefusal,
  type AuditItemsRefusal,
  type AuditResponseItem,
  type AuditSignOffRefusal,
  type AuditState,
  canAttestNoDeadlineStated,
  checkAuditFiling,
  checkAuditSignOff,
  checkReadyForReview,
  checkResponseItems,
  signOffFingerprint,
} from "../domain";
import type { M25ReadActor, M25WriteActor } from "./actor";
import {
  type AppealSourcePorts,
  UNBOUND_APPEAL_SOURCES,
  describeEnclosures,
} from "./appeal-packet-sources";
import { VersionConflictError } from "./concurrency";
import { earliestOpenDueAt } from "./recorded-deadline-view";
import { type ClaimFactsPort, m23ClaimFactsPort } from "./remittance-ports";
import { providerEntityScopeCondition } from "./scope";
import { recordFilingAttempt } from "./submission-service";
import type { WriteOutboxPort } from "./write-service";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
type Row = typeof schema.auditRequest.$inferSelect;

export interface AuditResponseView {
  readonly items: readonly AuditResponseItem[];
  readonly documents: readonly {
    readonly id: string;
    readonly claimId: string;
    readonly documentId: string;
    readonly attachedAt: string;
  }[];
  readonly sentToReviewByMembershipId: string | null;
  readonly reviewedByMembershipId: string | null;
  readonly reviewedAt: string | null;
  /** When a person attested the request letter states no due date; null = not attested. */
  readonly deadlineNoneStatedAt: string | null;
  /** Present once the response has been filed. */
  readonly filing: {
    readonly channel: string;
    readonly confirmationRef: string;
    readonly filedAt: string;
    readonly filedLate: boolean;
  } | null;
}

export interface AuditFilingInput {
  readonly channel: string;
  readonly confirmationRef: string;
  /** When the response was actually sent (ISO instant). */
  readonly filedAt: string;
  readonly lateAcknowledged?: boolean;
  readonly receiptDocumentId?: string;
  /** The live claim whose patient owns the receipt document; optional when the request covers exactly one claim. */
  readonly receiptClaimId?: string;
}

export interface AuditResponseOps {
  setResponseItems(
    actor: M25WriteActor,
    id: string,
    items: readonly AuditResponseItem[],
    ifMatch: number,
  ): Promise<{ id: string; version: number }>;
  attachAuditDocument(
    actor: M25WriteActor,
    id: string,
    input: { claimId: string; documentId: string },
    ifMatch: number,
  ): Promise<{ id: string; version: number }>;
  detachAuditDocument(
    actor: M25WriteActor,
    id: string,
    documentId: string,
    ifMatch: number,
  ): Promise<{ id: string; version: number }>;
  attestNoDeadlineStated(
    actor: M25WriteActor,
    id: string,
    ifMatch: number,
  ): Promise<{ id: string; version: number }>;
  signOffAudit(
    actor: M25WriteActor,
    id: string,
    ifMatch: number,
  ): Promise<{ id: string; version: number }>;
  submitAuditResponse(
    actor: M25WriteActor,
    id: string,
    input: AuditFilingInput,
    ifMatch: number,
  ): Promise<{ id: string; version: number }>;
}

export interface AuditResponsePorts {
  readonly outbox?: WriteOutboxPort;
  readonly sources?: AppealSourcePorts;
  readonly claims?: ClaimFactsPort;
}

type Refusal = AuditItemsRefusal | AuditSignOffRefusal | AuditFilingRefusal;

const REFUSAL_MESSAGE: Readonly<Record<Refusal, string>> = {
  ITEMS_TOO_MANY: "the response checklist holds too many items",
  ITEM_LABEL_REQUIRED: "every checklist item needs a label",
  ITEM_LABEL_TOO_LONG: "a checklist label is too long",
  ITEM_LABEL_DUPLICATE: "two checklist items have the same label",
  ITEM_STATE_INVALID: "a checklist item must be pending, ready or not applicable",
  REVIEWER_IS_ASSEMBLER: "the person who sent this packet to review cannot sign it off",
  REVIEWER_IS_PREPARER:
    "a person who attached a document to this packet or typed its checklist cannot sign it off",
  ALREADY_SIGNED_OFF: "this packet is already signed off",
  FILED_BEFORE_REVIEW: "the response cannot be sent before the packet was signed off",
  PACKET_EMPTY: "attach at least one document before sign-off",
  CHECKLIST_INCOMPLETE: "every checklist item must be marked ready or not applicable",
  NOT_SIGNED_OFF: "the packet has not been signed off",
  CHANNEL_INVALID: "choose how the response was sent",
  PROOF_REQUIRED: "record the confirmation or tracking reference from the channel",
  FILED_IN_FUTURE: "the filing time cannot be in the future",
  DEADLINE_OR_ATTESTATION_REQUIRED:
    "record the due date from the request letter, or attest that the letter states none, before filing",
  LATE_ACKNOWLEDGEMENT_REQUIRED:
    "a recorded due date has passed; acknowledge that it was filed late to record it",
};
const CONFLICT_REFUSALS = new Set<Refusal>([
  "REVIEWER_IS_ASSEMBLER",
  "REVIEWER_IS_PREPARER",
  "ALREADY_SIGNED_OFF",
  "NOT_SIGNED_OFF",
]);

function refuse(code: Refusal): never {
  throw new ChartWardenError(
    `AUDIT_${code}`,
    REFUSAL_MESSAGE[code],
    CONFLICT_REFUSALS.has(code) ? 409 : 422,
  );
}

const iso = (d: Date): string => d.toISOString();

const itemsOf = (value: unknown): AuditResponseItem[] =>
  Array.isArray(value)
    ? value.flatMap((v) =>
        v && typeof v === "object" && typeof (v as AuditResponseItem).label === "string"
          ? [{ label: (v as AuditResponseItem).label, state: (v as AuditResponseItem).state }]
          : [],
      )
    : [];

/**
 * The move to review runs the same packet rules as sign-off (minus the reviewer checks), so a request can never enter
 * a state that sign-off cannot leave. Called by the state move inside its transaction.
 */
export async function assertReadyForReview(tx: Tx, row: Row): Promise<void> {
  const DOC = schema.auditRequestDocument;
  const live = await tx
    .select({ id: DOC.id })
    .from(DOC)
    .where(and(eq(DOC.auditRequestId, row.id), isNull(DOC.removedAt)));
  const refusal = checkReadyForReview({
    items: itemsOf(row.responseItems),
    attachedCount: live.length,
  });
  if (refusal) refuse(refusal);
}

/** The packet facts shown on the request, read inside the caller's transaction. */
export async function loadAuditResponseView(tx: Tx, row: Row): Promise<AuditResponseView> {
  const DOC = schema.auditRequestDocument;
  const docs = await tx
    .select()
    .from(DOC)
    .where(and(eq(DOC.auditRequestId, row.id), isNull(DOC.removedAt)))
    .orderBy(asc(DOC.attachedAt), asc(DOC.id));
  return {
    items: itemsOf(row.responseItems),
    documents: docs.map((d) => ({
      id: d.id,
      claimId: d.claimId,
      documentId: d.documentId,
      attachedAt: iso(d.attachedAt),
    })),
    sentToReviewByMembershipId: row.sentToReviewByMembershipId,
    reviewedByMembershipId: row.reviewedByMembershipId,
    reviewedAt: row.reviewedAt ? iso(row.reviewedAt) : null,
    deadlineNoneStatedAt: row.deadlineNoneStatedAt ? iso(row.deadlineNoneStatedAt) : null,
    filing:
      row.packetManifest && row.responseChannel && row.responseConfirmationRef && row.respondedAt
        ? {
            channel: row.responseChannel,
            confirmationRef: row.responseConfirmationRef,
            filedAt: iso(row.respondedAt),
            filedLate: row.responseFiledLate,
          }
        : null,
  };
}

export function buildAuditResponseOps(
  db: DbClient,
  ports: AuditResponsePorts = {},
): AuditResponseOps {
  const sources = ports.sources ?? UNBOUND_APPEAL_SOURCES;
  const claimFacts = ports.claims ?? m23ClaimFactsPort;
  const AR = schema.auditRequest;
  const DOC = schema.auditRequestDocument;
  const ARC = schema.auditRequestClaim;
  const RD = schema.recordedDeadline;
  const EV = schema.auditRequestEvent;

  async function loadRequest(tx: Tx, actor: M25ReadActor, id: string): Promise<Row> {
    const scope = providerEntityScopeCondition(AR.providerEntityId, actor.providerEntityScope);
    const rows = await tx
      .select()
      .from(AR)
      .where(scope ? and(eq(AR.id, id), scope) : eq(AR.id, id))
      .limit(1);
    if (!rows[0]) throw new NotFoundError("audit request");
    return rows[0];
  }

  const requireState = (cur: Row, ...states: AuditState[]): void => {
    if (!states.includes(cur.state as AuditState)) {
      throw new ChartWardenError(
        "AUDIT_WRONG_STATE",
        `this change needs the audit request to be '${states.join("' or '")}', not '${cur.state}'`,
        409,
      );
    }
  };

  /** Moves the version under If-Match; `set` carries any other columns for the same write. */
  async function bump(
    tx: Tx,
    cur: Row,
    ifMatch: number,
    set: Partial<typeof AR.$inferInsert> = {},
  ): Promise<{ id: string; version: number }> {
    const updated = await tx
      .update(AR)
      .set({ ...set, version: cur.version + 1, updatedAt: new Date() })
      .where(and(eq(AR.id, cur.id), eq(AR.version, ifMatch)))
      .returning({ id: AR.id, version: AR.version });
    if (!updated[0]) throw new VersionConflictError(cur.version);
    return updated[0];
  }

  const event = (
    tx: Tx,
    actor: M25WriteActor,
    id: string,
    eventKind: string,
    eventPayload?: Record<string, unknown>,
  ) =>
    tx.insert(EV).values({
      organizationId: actor.organizationId,
      auditRequestId: id,
      eventKind,
      eventPayload: eventPayload ?? null,
      actorMembershipId: actor.membershipId,
    });

  /** The fingerprint of everything a reviewer signs off, read inside the caller's transaction. */
  async function fingerprintOf(tx: Tx, cur: Row): Promise<string> {
    const docs = await tx
      .select({ documentId: DOC.documentId, claimId: DOC.claimId })
      .from(DOC)
      .where(and(eq(DOC.auditRequestId, cur.id), isNull(DOC.removedAt)));
    const deadlines = await tx.select().from(RD).where(eq(RD.auditRequestId, cur.id));
    return signOffFingerprint({
      claimIds: await liveClaimIds(tx, cur.id),
      items: itemsOf(cur.responseItems),
      documents: docs,
      deadlines: deadlines.map((d) => ({ id: d.id, dueOn: d.dueOn, satisfiedOn: d.satisfiedOn })),
      noDeadlineStatedAttested: cur.deadlineNoneStatedAt !== null,
    });
  }

  async function liveClaimIds(tx: Tx, id: string): Promise<string[]> {
    const rows = await tx
      .select({ claimId: ARC.claimId })
      .from(ARC)
      .where(and(eq(ARC.auditRequestId, id), isNull(ARC.removedAt)))
      .orderBy(asc(ARC.createdAt));
    return rows.map((r) => r.claimId);
  }

  async function patientOfClaim(organizationId: string, claimId: string): Promise<string> {
    const claim = await sources.claims().claimCopyForAppeal(organizationId, claimId);
    if (!claim) {
      throw new ChartWardenError(
        "AUDIT_CLAIM_UNAVAILABLE",
        "a claim of this audit request cannot be read, so documents cannot be validated",
        422,
      );
    }
    return claim.patientId;
  }

  async function describeOne(
    organizationId: string,
    claimId: string,
    documentId: string,
    patients: Map<string, string>,
  ) {
    let patientId = patients.get(claimId);
    if (patientId === undefined) {
      patientId = await patientOfClaim(organizationId, claimId);
      patients.set(claimId, patientId);
    }
    const described = await describeEnclosures(
      sources.documents(),
      organizationId,
      patientId,
      [documentId],
      undefined,
      "audit response",
    );
    return described.attached[0]!;
  }

  return {
    async setResponseItems(actor, id, items, ifMatch) {
      const refusal = checkResponseItems(items);
      if (refusal) refuse(refusal);
      const cleaned = items.map((i) => ({ label: i.label.trim(), state: i.state }));
      return withOrgContext(db, actor, async (tx) => {
        const cur = await loadRequest(tx, actor, id);
        requireState(cur, "received", "in_assembly");
        const result = await bump(tx, cur, ifMatch, { responseItems: cleaned });
        await event(tx, actor, id, "response_items_set", { count: cleaned.length });
        return result;
      });
    },

    async attachAuditDocument(actor, id, input, ifMatch) {
      return withOrgContext(db, actor, async (tx) => {
        const cur = await loadRequest(tx, actor, id);
        requireState(cur, "in_assembly");
        if (!(await liveClaimIds(tx, id)).includes(input.claimId)) {
          throw new ChartWardenError(
            "AUDIT_CLAIM_NOT_ON_REQUEST",
            "attach the document to one of the claims on this audit request",
            422,
          );
        }
        const live = await tx
          .select({ documentId: DOC.documentId })
          .from(DOC)
          .where(and(eq(DOC.auditRequestId, id), isNull(DOC.removedAt)));
        if (live.length >= MAX_AUDIT_ENCLOSURES) {
          throw new ChartWardenError(
            "AUDIT_TOO_MANY_ENCLOSURES",
            `an audit response carries at most ${MAX_AUDIT_ENCLOSURES} documents`,
            422,
          );
        }
        if (live.some((d) => d.documentId === input.documentId)) {
          throw new ChartWardenError(
            "AUDIT_DUPLICATE_DOCUMENT",
            "that document is already attached",
            409,
          );
        }
        await describeOne(actor.organizationId, input.claimId, input.documentId, new Map());
        const result = await bump(tx, cur, ifMatch);
        await tx.insert(DOC).values({
          organizationId: actor.organizationId,
          auditRequestId: id,
          claimId: input.claimId,
          documentId: input.documentId,
          attachedByMembershipId: actor.membershipId,
        });
        await event(tx, actor, id, "document_attached", { documentId: input.documentId });
        return result;
      });
    },

    async detachAuditDocument(actor, id, documentId, ifMatch) {
      return withOrgContext(db, actor, async (tx) => {
        const cur = await loadRequest(tx, actor, id);
        requireState(cur, "in_assembly");
        const removed = await tx
          .update(DOC)
          .set({ removedAt: new Date() })
          .where(
            and(eq(DOC.auditRequestId, id), eq(DOC.documentId, documentId), isNull(DOC.removedAt)),
          )
          .returning({ id: DOC.id });
        if (!removed[0]) throw new NotFoundError("attached document");
        const result = await bump(tx, cur, ifMatch);
        await event(tx, actor, id, "document_removed", { documentId });
        return result;
      });
    },

    async attestNoDeadlineStated(actor, id, ifMatch) {
      return withOrgContext(db, actor, async (tx) => {
        const cur = await loadRequest(tx, actor, id);
        requireState(cur, "received", "in_assembly", "in_review");
        if (cur.reviewedAt !== null) {
          throw new ChartWardenError(
            "AUDIT_SIGNED_OFF",
            "the packet is signed off, so the attestation can no longer change",
            409,
          );
        }
        const deadlines = await tx.select({ id: RD.id }).from(RD).where(eq(RD.auditRequestId, id));
        const refusal = canAttestNoDeadlineStated({
          recordedDeadlineCount: deadlines.length,
          alreadyAttested: cur.deadlineNoneStatedAt !== null,
        });
        if (refusal === "DEADLINES_EXIST") {
          throw new ChartWardenError(
            "AUDIT_DEADLINES_EXIST",
            "a due date is already recorded for this request; the none-stated attestation does not apply",
            409,
          );
        }
        if (refusal === "ALREADY_ATTESTED") {
          throw new ChartWardenError(
            "AUDIT_ALREADY_ATTESTED",
            "the none-stated attestation is already recorded",
            409,
          );
        }
        const result = await bump(tx, cur, ifMatch, {
          deadlineNoneStatedAt: new Date(),
          deadlineNoneStatedByMembershipId: actor.membershipId,
        });
        await event(tx, actor, id, "deadline_none_stated");
        return result;
      });
    },

    async signOffAudit(actor, id, ifMatch) {
      return withOrgContext(db, actor, async (tx) => {
        const cur = await loadRequest(tx, actor, id);
        requireState(cur, "in_review");
        if (!cur.sentToReviewByMembershipId) {
          throw new ChartWardenError(
            "AUDIT_ASSEMBLER_UNKNOWN",
            "this request was moved to review before the preparer was recorded, so it cannot be signed off; withdraw it and log a new request",
            409,
          );
        }
        const live = await tx
          .select({ id: DOC.id, by: DOC.attachedByMembershipId })
          .from(DOC)
          .where(and(eq(DOC.auditRequestId, id), isNull(DOC.removedAt)));
        const checklistSetters = await tx
          .select({ by: EV.actorMembershipId })
          .from(EV)
          .where(and(eq(EV.auditRequestId, id), eq(EV.eventKind, "response_items_set")));
        const signOffDeadlines = await tx
          .select({ id: RD.id })
          .from(RD)
          .where(eq(RD.auditRequestId, id));
        const preparers = [...live.map((d) => d.by), ...checklistSetters.map((e) => e.by)].filter(
          (m): m is string => m !== null,
        );
        const refusal = checkAuditSignOff({
          assemblerMembershipId: cur.sentToReviewByMembershipId,
          reviewerMembershipId: actor.membershipId,
          preparerMembershipIds: preparers,
          alreadySignedOff: cur.reviewedByMembershipId !== null,
          recordedDeadlineCount: signOffDeadlines.length,
          noDeadlineStatedAttested: cur.deadlineNoneStatedAt !== null,
          items: itemsOf(cur.responseItems),
          attachedCount: live.length,
        });
        if (refusal) refuse(refusal);
        const result = await bump(tx, cur, ifMatch, {
          reviewedByMembershipId: actor.membershipId,
          reviewedAt: new Date(),
          signedOffHash: await fingerprintOf(tx, cur),
        });
        await event(tx, actor, id, "signed_off");
        return result;
      });
    },

    async submitAuditResponse(actor, id, input, ifMatch) {
      const filedAt = new Date(input.filedAt);
      if (Number.isNaN(filedAt.getTime())) {
        throw new ChartWardenError(
          "AUDIT_INVALID_FILING_TIME",
          "the filing time is not a real date and time",
          422,
        );
      }
      // No outbox, no retained copy: refuse rather than record a filing whose PDF would never be rendered.
      const outbox = ports.outbox;
      if (!outbox) {
        throw new ChartWardenError(
          "SEAM_UNBOUND",
          "the audit response packet outbox is not bound",
          503,
        );
      }
      const now = new Date();
      return withOrgContext(db, actor, async (tx) => {
        const cur = await loadRequest(tx, actor, id);
        requireState(cur, "in_review");
        const deadlines = await tx
          .select()
          .from(RD)
          .where(eq(RD.auditRequestId, id))
          .orderBy(asc(RD.dueOn));
        const openDue = earliestOpenDueAt(deadlines);
        const refusal = checkAuditFiling({
          signedOffByMembershipId: cur.reviewedByMembershipId,
          channel: input.channel,
          confirmationRef: input.confirmationRef,
          filedAt,
          reviewedAt: cur.reviewedAt as Date,
          now,
          recordedDeadlineCount: deadlines.length,
          noDeadlineStatedAttested: cur.deadlineNoneStatedAt !== null,
          earliestOpenDueAt: openDue,
          lateAcknowledged: input.lateAcknowledged === true,
        });
        if (refusal) refuse(refusal);
        // What was signed off is what is filed: anything that moved since sign-off voids it.
        if ((await fingerprintOf(tx, cur)) !== cur.signedOffHash) {
          throw new ChartWardenError(
            "AUDIT_SIGNOFF_STALE",
            "the packet changed after it was signed off; it must be signed off again before filing",
            409,
          );
        }

        // Re-validate everything being filed NOW (a document can have been superseded or reclassified since it was
        // attached, a claim removed), then freeze exactly that list.
        const live = await tx
          .select()
          .from(DOC)
          .where(and(eq(DOC.auditRequestId, id), isNull(DOC.removedAt)))
          .orderBy(asc(DOC.attachedAt), asc(DOC.id));
        const claimIds = await liveClaimIds(tx, id);
        if (live.some((d) => !claimIds.includes(d.claimId))) {
          throw new ChartWardenError(
            "AUDIT_DOCUMENT_CLAIM_REMOVED",
            "a document is attached to a claim that was removed from the request; detach it first",
            409,
          );
        }
        const patients = new Map<string, string>();
        const enclosures = [];
        for (const d of live) {
          const described = await describeOne(
            actor.organizationId,
            d.claimId,
            d.documentId,
            patients,
          );
          enclosures.push({ ...described, claimId: d.claimId });
        }
        if (input.receiptDocumentId) {
          const receiptClaim =
            input.receiptClaimId ?? (claimIds.length === 1 ? claimIds[0] : undefined);
          if (!receiptClaim || !claimIds.includes(receiptClaim)) {
            throw new ChartWardenError(
              "AUDIT_RECEIPT_CLAIM_REQUIRED",
              "name the claim of this request whose patient owns the receipt document",
              422,
            );
          }
          await describeOne(actor.organizationId, receiptClaim, input.receiptDocumentId, patients);
        }
        const claims = [];
        for (const claimId of claimIds) {
          const facts = await claimFacts.byId(tx, claimId);
          claims.push({ claimId, claimControlNumber: facts?.claimControlNumber ?? null });
        }
        const filedLate = openDue !== null && filedAt.getTime() > openDue.getTime();
        const items = itemsOf(cur.responseItems);
        // The payload is what M22 renders as the retained copy: a document with no title (or any other invalid
        // fact) is a typed refusal here, never a render that fails later.
        let packet: ReturnType<typeof buildAuditResponsePacketRenderPayload>;
        try {
          packet = buildAuditResponsePacketRenderPayload({
          auditRequestId: id,
          authorityKind: cur.authorityKind,
          authorityName: cur.authorityName,
          requestReference: cur.requestReference,
          requestDatedOn: cur.requestDatedOn,
          receivedOn: cur.receivedOn,
          filedAt: iso(filedAt),
          filedLate,
          filingChannel: input.channel,
          filingConfirmationRef: input.confirmationRef.trim(),
          reviewedAt: iso(cur.reviewedAt as Date),
          noDeadlineStatedAttested: cur.deadlineNoneStatedAt !== null,
          deadlines: deadlines.map((d) => ({
            label: d.label,
            dueOn: d.dueOn,
            satisfiedOn: d.satisfiedOn,
          })),
          checklist: items.map((i) => ({
            label: i.label,
            state: i.state === "not_applicable" ? "not_applicable" : "ready",
          })),
          claims,
          enclosures,
        });
        } catch (e) {
          throw new ChartWardenError(
            "AUDIT_PACKET_INVALID",
            `the packet cannot be rendered: ${e instanceof Error ? e.message : "invalid packet"}`,
            422,
          );
        }
        const manifest = {
          version: 1,
          frozenAt: iso(now),
          // Counts and ids only: the typed labels live in the retained PDF, not in this audited column.
          checklist: {
            total: items.length,
            ready: items.filter((i) => i.state === "ready").length,
            notApplicable: items.filter((i) => i.state === "not_applicable").length,
          },
          documents: live.map((d) => ({ documentId: d.documentId, claimId: d.claimId })),
          deadlines: deadlines.map((d) => ({ id: d.id, dueOn: d.dueOn })),
          noDeadlineStatedAttested: cur.deadlineNoneStatedAt !== null,
        };
        const result = await bump(tx, cur, ifMatch, {
          state: "responded",
          respondedAt: filedAt,
          responseChannel: input.channel,
          responseConfirmationRef: input.confirmationRef.trim(),
          responseFiledLate: filedLate,
          packetManifest: manifest,
        });
        await event(tx, actor, id, "responded", { channel: input.channel, filedLate });
        // The filing's attempt record (born acknowledged: the proof is required above, like an ADR response).
        await recordFilingAttempt(tx, {
          organizationId: actor.organizationId,
          providerEntityId: cur.providerEntityId,
          purpose: "audit_response",
          subjectId: id,
          channel: input.channel as AuditFilingChannel,
          confirmationRef: input.confirmationRef.trim(),
          receiptAt: filedAt,
          receiptDocumentId: input.receiptDocumentId ?? null,
          packetManifest: manifest,
          actorMembershipId: actor.membershipId,
        });
        await outbox.publish(tx, {
          eventName: "m25.audit_response_packet.render_requested",
          organizationId: actor.organizationId,
          aggregateKind: "audit_request",
          aggregateId: id,
          payload: { auditRequestId: id, payload: packet },
        });
        return result;
      });
    },
  };
}
