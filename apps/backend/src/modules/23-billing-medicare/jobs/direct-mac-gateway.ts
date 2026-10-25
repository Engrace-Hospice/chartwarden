// apps/backend/src/modules/23-billing-medicare/jobs/direct-mac-gateway.ts — adapts the existing launch-gateway ports
// (`X12ClientPort` generation/parse + `MacPortalPort` upload/pull) to the `DirectMacGateway` that the `direct_mac`
// ClearinghouseTransport consumes (ADR-0053, issue #706). Pure composition: it adds no network access; every byte
// still leaves through `launch-gateway.ts` / the `*-client` packages.
import { type ClaimDocument837i, repositories } from "@chartwarden/billing";
import type { DbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  type AckEvent,
  type DirectMacGateway,
  type SubmissionKind,
  UploadNotSentError,
} from "@chartwarden/x12-837-client";
import type { MacPortalPort, X12ClientPort } from "./m23-jobs";

export interface DirectMacGatewayDeps {
  readonly x12: X12ClientPort;
  readonly macPortal: MacPortalPort;
  /** Our control number for a submission row, so a 277CA (which names the submission) maps to a port event. */
  readonly controlNumberOf: (
    organizationId: string,
    submissionId: string,
  ) => Promise<string | null>;
  readonly now?: () => Date;
}

const UPLOAD_KIND = { claim: "claim_837i", noe: "noe", notr: "notr" } as const satisfies Record<
  SubmissionKind,
  "claim_837i" | "noe" | "notr"
>;

/** `launch-gateway.ts` reports a non-2xx answer as "... returned HTTP <status>". */
const DEFINITE_REFUSAL = /returned HTTP 4\d\d$/;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function field(document: unknown, name: string): string {
  const value = (document as Record<string, unknown> | null)?.[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`direct_mac: submission document needs a string ${name}`);
  }
  return value;
}

/**
 * JSON submission documents for the direct-MAC path carry the ids the gateway generators need:
 * claim `{ claimId, claimDocument }`, NOE `{ noeId }`, NOTR `{ notrId }`. (A raw X12 payload skips generation.)
 */
export function buildDirectMacGateway(deps: DirectMacGatewayDeps): DirectMacGateway {
  const now = deps.now ?? (() => new Date());
  return {
    async generate({ kind, organizationId, controlNumber, document }) {
      if (kind === "claim") {
        const generated = await deps.x12.generate837i({
          organizationId,
          claimId: field(document, "claimId"),
          claimControlNumber: controlNumber,
          claimDocument: (document as { claimDocument: ClaimDocument837i }).claimDocument,
        });
        return { x12: generated.x12 };
      }
      if (kind === "noe") {
        const generated = await deps.x12.generateNoe({
          organizationId,
          noeId: field(document, "noeId"),
          noeControlNumber: controlNumber,
        });
        return { x12: generated.x12 };
      }
      const generated = await deps.x12.generateNotr({
        organizationId,
        notrId: field(document, "notrId"),
        notrControlNumber: controlNumber,
      });
      return { x12: generated.x12 };
    },

    async upload({ kind, organizationId, providerEntityId, controlNumber, x12 }) {
      try {
        const uploaded = await deps.macPortal.upload({
          organizationId,
          providerEntityId,
          kind: UPLOAD_KIND[kind],
          x12,
          controlNumber,
        });
        return { accepted: uploaded.accepted, fileId: uploaded.generatedFileUri };
      } catch (err) {
        // A 4xx answer proves the portal took nothing; anything else (5xx, timeout, reset) is in doubt.
        if (err instanceof Error && DEFINITE_REFUSAL.test(err.message)) {
          throw new UploadNotSentError("the MAC gateway refused the upload");
        }
        throw err;
      }
    },

    async pullAcknowledgments(ctx) {
      const jurisdiction = ctx.jurisdiction;
      if (!jurisdiction) throw new Error("direct_mac: the context carries no MAC jurisdiction");
      const today = now().toISOString().slice(0, 10);
      const events: AckEvent[] = [];
      for (const file of await deps.macPortal.pullPending999(jurisdiction)) {
        for (const r of await deps.x12.parse999({
          macJurisdiction: jurisdiction,
          rawFileUri: file.rawFileUri,
        })) {
          if (r.organizationId !== ctx.organizationId) continue;
          events.push({
            eventId: `999:${r.ackFileUri}:${r.claimControlNumber}`,
            stage: "clearinghouse",
            disposition: r.accepted ? "accepted" : "rejected",
            controlNumber: r.claimControlNumber,
            reasonCodes: r.reasonCodes,
            occurredAt: r.functionalGroupDate ?? r.interchangeDate ?? today,
          });
        }
      }
      for (const file of await deps.macPortal.pullPending277ca(jurisdiction)) {
        for (const r of await deps.x12.parse277ca({
          macJurisdiction: jurisdiction,
          rawFileUri: file.rawFileUri,
        })) {
          if (r.organizationId !== ctx.organizationId) continue;
          const controlNumber = await deps.controlNumberOf(r.organizationId, r.submissionId);
          if (controlNumber === null) continue;
          const statusDay = r.statusEffectiveDate;
          events.push({
            eventId: `277ca:${r.ackFileUri}:${controlNumber}`,
            stage: "payer",
            // The port has no "partial": it is carried as a rejection with a PARTIAL marker.
            disposition: r.outcome === "accepted" ? "accepted" : "rejected",
            controlNumber,
            reasonCodes: r.outcome === "partial" ? ["PARTIAL", ...r.reasonCodes] : r.reasonCodes,
            occurredAt: statusDay && ISO_DAY.test(statusDay) ? statusDay : today,
            ...(r.outcome === "accepted" && r.payerClaimControlNumber
              ? { payerClaimNumber: r.payerClaimControlNumber }
              : {}),
          });
        }
      }
      return events;
    },
  };
}

/** Our control number for a submission row, read under the org's RLS envelope (system actor); null when unknown. */
export function buildSubmissionControlNumberReader(
  db: DbClient,
): DirectMacGatewayDeps["controlNumberOf"] {
  return (organizationId, submissionId) =>
    withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const row = await new repositories.ClaimSubmissionRepository(tx as never).findById(
        submissionId,
      );
      return row?.claimControlNumber ?? null;
    });
}
