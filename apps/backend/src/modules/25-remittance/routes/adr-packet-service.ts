// apps/backend/src/modules/25-remittance/routes/adr-packet-service.ts — the ADR response packet (hospice ADR/TPE/QIC
// PRD milestone 2b): attach the documents the MAC asked for, tick the checklist, a second person's sign-off, and
// recording the filing with its proof. Every command runs under `withOrgContext` (RLS).
//
//   - Every packet change moves the case version, so a sign-off made on a stale If-Match is a 409: a reviewer
//     signs off what they saw, never something edited under them.
//   - Attachments obey the appeal enclosure rules (`describeEnclosures`): org-visible, active, the claim's
//     patient, never 42 CFR Part 2; refusals carry a reason code, never a title.
//   - Filing records a response made OUTSIDE ChartWarden (sending electronically is milestone 6). It freezes an exact
//     manifest (document ids + checklist, no titles) in the same transaction that moves the case to `submitted`
//     and emits `m25.adr_packet.render_requested`, so M22 files the cover-and-index PDF as the retained copy.
//     Database triggers keep the manifest, the filing facts and the enclosure list immutable afterwards.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  ChartWardenError,
  MAX_ADR_ENCLOSURES,
  NotFoundError,
  buildAdrPacketRenderPayload,
} from "@chartwarden/types";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  ADR_CHECKLIST_KEYS,
  type AdrChecklistState,
  type AdrFilingRefusal,
  type AdrSignOffRefusal,
  type SubmissionChannel,
  checkFiling,
  checkSignOff,
  isChecklistKey,
} from "../domain";
import type { M25ReadActor, M25WriteActor } from "./actor";
import {
  type AppealSourcePorts,
  UNBOUND_APPEAL_SOURCES,
  describeEnclosures,
} from "./appeal-packet-sources";
import { VersionConflictError } from "./concurrency";
import { providerEntityScopeCondition } from "./scope";
import { recordFilingAttempt } from "./submission-service";
import type { WriteOutboxPort } from "./write-service";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

export interface AdrPacketView {
  readonly documents: {
    readonly id: string;
    readonly documentId: string;
    readonly checklistKey: string | null;
    readonly attachedAt: string;
  }[];
  /** Every checklist key with its state (`pending` until ticked). */
  readonly checklist: { readonly key: string; readonly state: string }[];
  readonly sentToReviewByMembershipId: string | null;
  readonly reviewedByMembershipId: string | null;
  readonly reviewedAt: string | null;
  /** Present once the response has been filed. */
  readonly filing: {
    readonly channel: string;
    readonly confirmationRef: string;
    readonly filedAt: string;
    readonly filedLate: boolean;
    readonly receiptDocumentId: string | null;
  } | null;
}

export interface AdrFilingInput {
  readonly channel: string;
  readonly confirmationRef: string;
  /** When the response was actually sent (ISO instant). */
  readonly filedAt: string;
  readonly lateAcknowledged?: boolean;
  readonly receiptDocumentId?: string;
}

export interface AdrPacketOps {
  attachAdrDocument(
    actor: M25WriteActor,
    id: string,
    input: { documentId: string; checklistKey?: string },
    ifMatch: number,
  ): Promise<{ id: string; version: number }>;
  detachAdrDocument(
    actor: M25WriteActor,
    id: string,
    documentId: string,
    ifMatch: number,
  ): Promise<{ id: string; version: number }>;
  setAdrChecklistItem(
    actor: M25WriteActor,
    id: string,
    key: string,
    state: AdrChecklistState,
    ifMatch: number,
  ): Promise<{ id: string; version: number }>;
  signOffAdr(
    actor: M25WriteActor,
    id: string,
    ifMatch: number,
  ): Promise<{ id: string; version: number }>;
  submitAdr(
    actor: M25WriteActor,
    id: string,
    input: AdrFilingInput,
    ifMatch: number,
  ): Promise<{ id: string; version: number }>;
}

export interface AdrPacketPorts {
  readonly outbox?: WriteOutboxPort;
  readonly sources?: AppealSourcePorts;
}

const REFUSAL_MESSAGE: Readonly<Record<AdrSignOffRefusal | AdrFilingRefusal, string>> = {
  REVIEWER_IS_ASSEMBLER: "the person who sent this packet to review cannot sign it off",
  PACKET_EMPTY: "attach at least one document before sign-off",
  CHECKLIST_INCOMPLETE: "every checklist item must be marked ready or not applicable",
  NOT_SIGNED_OFF: "the packet has not been signed off",
  CHANNEL_INVALID: "choose how the response was sent",
  PROOF_REQUIRED: "record the confirmation or tracking reference from the MAC",
  FILED_IN_FUTURE: "the filing time cannot be in the future",
  LATE_ACKNOWLEDGEMENT_REQUIRED:
    "the response due date has passed; acknowledge that it was filed late to record it",
};
const CONFLICT_REFUSALS = new Set<string>(["REVIEWER_IS_ASSEMBLER", "NOT_SIGNED_OFF"]);

function refuse(code: AdrSignOffRefusal | AdrFilingRefusal): never {
  throw new ChartWardenError(code, REFUSAL_MESSAGE[code], CONFLICT_REFUSALS.has(code) ? 409 : 422);
}

const iso = (d: Date): string => d.toISOString();

/** The packet facts shown on the case, read inside the caller's transaction. */
export async function loadAdrPacketView(
  tx: Tx,
  row: typeof schema.adrCase.$inferSelect,
): Promise<AdrPacketView> {
  const DOC = schema.adrCaseDocument;
  const docs = await tx
    .select()
    .from(DOC)
    .where(and(eq(DOC.adrCaseId, row.id), isNull(DOC.removedAt)))
    .orderBy(asc(DOC.attachedAt), asc(DOC.id));
  const stored = (row.checklist ?? {}) as Record<string, string>;
  return {
    documents: docs.map((d) => ({
      id: d.id,
      documentId: d.documentId,
      checklistKey: d.checklistKey,
      attachedAt: iso(d.attachedAt),
    })),
    checklist: ADR_CHECKLIST_KEYS.map((key) => ({ key, state: stored[key] ?? "pending" })),
    sentToReviewByMembershipId: row.sentToReviewByMembershipId,
    reviewedByMembershipId: row.reviewedByMembershipId,
    reviewedAt: row.reviewedAt ? iso(row.reviewedAt) : null,
    filing:
      row.filedAt && row.filingChannel && row.filingConfirmationRef
        ? {
            channel: row.filingChannel,
            confirmationRef: row.filingConfirmationRef,
            filedAt: iso(row.filedAt),
            filedLate: row.filedLate,
            receiptDocumentId: row.receiptDocumentId,
          }
        : null,
  };
}

export function buildAdrPacketOps(db: DbClient, ports: AdrPacketPorts = {}): AdrPacketOps {
  const sources = ports.sources ?? UNBOUND_APPEAL_SOURCES;
  const ADR = schema.adrCase;
  const DOC = schema.adrCaseDocument;
  const EV = schema.adrCaseEvent;

  async function loadCase(tx: Tx, actor: M25ReadActor, id: string) {
    const scope = providerEntityScopeCondition(ADR.providerEntityId, actor.providerEntityScope);
    const rows = await tx
      .select()
      .from(ADR)
      .where(scope ? and(eq(ADR.id, id), scope) : eq(ADR.id, id))
      .limit(1);
    if (!rows[0]) throw new NotFoundError("ADR case");
    return rows[0];
  }

  const requireState = (cur: { state: string }, state: string): void => {
    if (cur.state !== state) {
      throw new ChartWardenError(
        "ADR_WRONG_STATE",
        `this change needs the ADR to be '${state}', not '${cur.state}'`,
        409,
      );
    }
  };

  /** Moves the version under If-Match; `set` carries any other columns for the same write. */
  async function bump(
    tx: Tx,
    cur: { id: string; version: number },
    ifMatch: number,
    set: Partial<typeof ADR.$inferInsert> = {},
  ): Promise<{ id: string; version: number }> {
    const updated = await tx
      .update(ADR)
      .set({ ...set, version: cur.version + 1 })
      .where(and(eq(ADR.id, cur.id), eq(ADR.version, ifMatch)))
      .returning({ id: ADR.id, version: ADR.version });
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
      adrCaseId: id,
      eventKind,
      ...(eventPayload ? { eventPayload } : {}),
      actorMembershipId: actor.membershipId,
    });

  async function claimPatientId(organizationId: string, claimId: string): Promise<string> {
    const claim = await sources.claims().claimCopyForAppeal(organizationId, claimId);
    if (!claim) {
      throw new ChartWardenError(
        "ADR_CLAIM_UNAVAILABLE",
        "the claim for this ADR cannot be read, so documents cannot be validated",
        422,
      );
    }
    return claim.patientId;
  }

  return {
    async attachAdrDocument(actor, id, input, ifMatch) {
      if (input.checklistKey !== undefined && !isChecklistKey(input.checklistKey)) {
        throw new ChartWardenError("INVALID_CHECKLIST_KEY", "unknown checklist item", 422);
      }
      return withOrgContext(db, actor, async (tx) => {
        const cur = await loadCase(tx, actor, id);
        requireState(cur, "in_assembly");
        const live = await tx
          .select({ documentId: DOC.documentId })
          .from(DOC)
          .where(and(eq(DOC.adrCaseId, id), isNull(DOC.removedAt)));
        if (live.length >= MAX_ADR_ENCLOSURES) {
          throw new ChartWardenError(
            "ADR_TOO_MANY_ENCLOSURES",
            `an ADR response carries at most ${MAX_ADR_ENCLOSURES} documents`,
            422,
          );
        }
        if (live.some((d) => d.documentId === input.documentId)) {
          throw new ChartWardenError(
            "ADR_DUPLICATE_DOCUMENT",
            "that document is already attached",
            409,
          );
        }
        const patientId = await claimPatientId(actor.organizationId, cur.claimId);
        await describeEnclosures(
          sources.documents(),
          actor.organizationId,
          patientId,
          [input.documentId],
          undefined,
          "ADR response",
        );
        const result = await bump(tx, cur, ifMatch);
        await tx.insert(DOC).values({
          organizationId: actor.organizationId,
          adrCaseId: id,
          documentId: input.documentId,
          checklistKey: input.checklistKey ?? null,
          attachedByMembershipId: actor.membershipId,
        });
        await event(tx, actor, id, "document_attached", {
          documentId: input.documentId,
          checklistKey: input.checklistKey ?? null,
        });
        return result;
      });
    },

    async detachAdrDocument(actor, id, documentId, ifMatch) {
      return withOrgContext(db, actor, async (tx) => {
        const cur = await loadCase(tx, actor, id);
        requireState(cur, "in_assembly");
        const removed = await tx
          .update(DOC)
          .set({ removedAt: new Date() })
          .where(and(eq(DOC.adrCaseId, id), eq(DOC.documentId, documentId), isNull(DOC.removedAt)))
          .returning({ id: DOC.id });
        if (!removed[0]) throw new NotFoundError("attached document");
        const result = await bump(tx, cur, ifMatch);
        await event(tx, actor, id, "document_removed", { documentId });
        return result;
      });
    },

    async setAdrChecklistItem(actor, id, key, state, ifMatch) {
      if (!isChecklistKey(key)) {
        throw new ChartWardenError("INVALID_CHECKLIST_KEY", "unknown checklist item", 422);
      }
      return withOrgContext(db, actor, async (tx) => {
        const cur = await loadCase(tx, actor, id);
        requireState(cur, "in_assembly");
        const result = await bump(tx, cur, ifMatch, {
          checklist: sql`${ADR.checklist} || ${JSON.stringify({ [key]: state })}::jsonb`,
        });
        await event(tx, actor, id, "checklist_updated", { key, state });
        return result;
      });
    },

    async signOffAdr(actor, id, ifMatch) {
      return withOrgContext(db, actor, async (tx) => {
        const cur = await loadCase(tx, actor, id);
        requireState(cur, "in_review");
        if (!cur.sentToReviewByMembershipId) {
          throw new ChartWardenError(
            "ADR_ASSEMBLER_UNKNOWN",
            "who sent this packet to review is not recorded; send it to review again",
            409,
          );
        }
        const live = await tx
          .select({ id: DOC.id })
          .from(DOC)
          .where(and(eq(DOC.adrCaseId, id), isNull(DOC.removedAt)));
        const refusal = checkSignOff({
          assemblerMembershipId: cur.sentToReviewByMembershipId,
          reviewerMembershipId: actor.membershipId,
          checklist: (cur.checklist ?? {}) as Record<string, string>,
          attachedCount: live.length,
        });
        if (refusal) refuse(refusal);
        const result = await bump(tx, cur, ifMatch, {
          reviewedByMembershipId: actor.membershipId,
          reviewedAt: new Date(),
        });
        await event(tx, actor, id, "signed_off");
        return result;
      });
    },

    async submitAdr(actor, id, input, ifMatch) {
      const filedAt = new Date(input.filedAt);
      if (Number.isNaN(filedAt.getTime())) {
        throw new ChartWardenError(
          "INVALID_FILING_TIME",
          "the filing time is not a real date and time",
          422,
        );
      }
      // No outbox, no retained copy: refuse rather than record a filing whose PDF would never be rendered.
      const outbox = ports.outbox;
      if (!outbox) {
        throw new ChartWardenError("SEAM_UNBOUND", "the ADR packet outbox is not bound", 503);
      }
      const now = new Date();
      return withOrgContext(db, actor, async (tx) => {
        const cur = await loadCase(tx, actor, id);
        requireState(cur, "in_review");
        const refusal = checkFiling({
          signedOffByMembershipId: cur.reviewedByMembershipId,
          channel: input.channel,
          confirmationRef: input.confirmationRef,
          filedAt,
          dueAt: cur.responseDueAt,
          lateAcknowledged: input.lateAcknowledged === true,
          now,
        });
        if (refusal) refuse(refusal);

        // Re-validate everything being filed NOW (a document can have been superseded or reclassified since it
        // was attached), then freeze exactly that list.
        const live = await tx
          .select()
          .from(DOC)
          .where(and(eq(DOC.adrCaseId, id), isNull(DOC.removedAt)))
          .orderBy(asc(DOC.attachedAt), asc(DOC.id));
        const patientId = await claimPatientId(actor.organizationId, cur.claimId);
        const described = await describeEnclosures(
          sources.documents(),
          actor.organizationId,
          patientId,
          live.map((d) => d.documentId),
          undefined,
          "ADR response",
        );
        if (input.receiptDocumentId) {
          await describeEnclosures(
            sources.documents(),
            actor.organizationId,
            patientId,
            [input.receiptDocumentId],
            undefined,
            "ADR response",
          );
        }
        const checklist = (cur.checklist ?? {}) as Record<string, string>;
        const filedLate = filedAt.getTime() > cur.responseDueAt.getTime();
        const packet = buildAdrPacketRenderPayload({
          adrCaseId: id,
          claimId: cur.claimId,
          macName: cur.macName,
          reviewType: cur.reviewType as "adr" | "re_adr",
          adrReference: cur.adrReference,
          requestedOn: cur.requestedOn,
          responseDueAt: iso(cur.responseDueAt),
          filedAt: iso(filedAt),
          filedLate,
          filingChannel: input.channel,
          filingConfirmationRef: input.confirmationRef.trim(),
          reviewedAt: iso(cur.reviewedAt as Date),
          checklist: ADR_CHECKLIST_KEYS.map((key) => ({
            key,
            state: checklist[key] === "not_applicable" ? "not_applicable" : "ready",
          })),
          enclosures: described.attached.map((e, i) => ({
            ...e,
            checklistKey: live[i]?.checklistKey ?? null,
          })),
        });
        const manifest = {
          version: 1,
          frozenAt: iso(now),
          checklist: packet.checklist,
          documents: live.map((d) => ({ documentId: d.documentId, checklistKey: d.checklistKey })),
        };
        const result = await bump(tx, cur, ifMatch, {
          state: "submitted",
          submittedAt: now,
          filingChannel: input.channel,
          filingConfirmationRef: input.confirmationRef.trim(),
          filedAt,
          filedLate,
          receiptDocumentId: input.receiptDocumentId ?? null,
          packetManifest: manifest,
        });
        await event(tx, actor, id, "submitted", { channel: input.channel, filedLate });
        // Milestone 6a: the filing's attempt record (already acknowledged: the case carried channel, reference, time).
        await recordFilingAttempt(tx, {
          organizationId: actor.organizationId,
          providerEntityId: cur.providerEntityId,
          purpose: "adr_response",
          subjectId: id,
          channel: input.channel as SubmissionChannel,
          confirmationRef: input.confirmationRef.trim(),
          receiptAt: filedAt,
          receiptDocumentId: input.receiptDocumentId ?? null,
          packetManifest: manifest,
          actorMembershipId: actor.membershipId,
        });
        await outbox.publish(tx, {
          eventName: "m25.adr_packet.render_requested",
          organizationId: actor.organizationId,
          aggregateKind: "adr_case",
          aggregateId: id,
          payload: { adrCaseId: id, payload: packet },
        });
        return result;
      });
    },
  };
}
