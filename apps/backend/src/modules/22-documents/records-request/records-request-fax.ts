// apps/backend/src/modules/22-documents/records-request/records-request-fax.ts — F-238: SENDING a records
// request by fax. The PDF the cover-sheet route serves (./cover-sheet.ts) goes out through M22's
// provider-agnostic outbound-fax port (../fax/outbound-fax.ts); every attempt is recorded
// (`intake_records_request_fax`, migration 0315) BEFORE the provider is called and settled after.
//
// Idempotent per request: at most one `sending` / `sent` attempt per request (a partial unique index in the
// database, the same rule in memory). A repeat to the same number returns the earlier send (`replayed`); to a
// different number it is refused (409) — re-dialling a different office with the same patient's details is a
// new disclosure, not a retry. A FAILED attempt may be retried. An attempt stuck in `sending` (the process
// died between recording it and hearing from the provider) is settled `failed` after
// FAX_SENDING_STALE_AFTER_MS so the request is not blocked forever.
//
// This file holds the vocabulary, the store contract, the in-memory store (route tests) and the
// orchestration; production binds the Drizzle store (./records-request-fax-db.ts) under RLS.
import { randomUUID } from "node:crypto";
import { DegradedError, NotFoundError, ChartWardenError } from "@wardenx/types";
import type { OutboundFaxTransport } from "../fax/outbound-fax";
import type { RenderedCoverSheet } from "./cover-sheet";
import type { RecordsRequestActor, RecordsRequestView } from "./records-request-service";

export const RECORDS_REQUEST_FAX_STATUSES = ["sending", "sent", "failed"] as const;
export type RecordsRequestFaxStatus = (typeof RECORDS_REQUEST_FAX_STATUSES)[number];

/** A request may be faxed while it is still awaiting records — not cancelled, not fully received, and not
 *  expired (extend it first: that re-opens it as `requested`). */
export const RECORDS_REQUEST_FAXABLE: ReadonlySet<RecordsRequestView["status"]> = new Set([
  "requested",
  "partially_received",
]);

/** A `sending` attempt older than this is treated as interrupted and settled `failed`. */
export const FAX_SENDING_STALE_AFTER_MS = 10 * 60 * 1000;
export const FAX_INTERRUPTED_REASON = "interrupted: no provider answer was recorded";

export interface RecordsRequestFaxView {
  readonly id: string;
  readonly recordsRequestId: string;
  /** E.164. */
  readonly faxNumber: string;
  readonly status: RecordsRequestFaxStatus;
  readonly provider: string;
  readonly providerMessageId: string | null;
  readonly pageCount: number;
  readonly failureReason: string | null;
  readonly attemptedAt: string;
  readonly sentAt: string | null;
  readonly failedAt: string | null;
}

export interface BeginFaxInput {
  readonly recordsRequestId: string;
  readonly referralId: string;
  readonly patientId: string | null;
  readonly faxNumber: string;
  readonly provider: string;
  readonly pageCount: number;
  readonly documentSha256: string;
}

export type BeginFaxResult =
  | { readonly kind: "started"; readonly attempt: RecordsRequestFaxView }
  /** A `sending` or `sent` attempt already holds the request. */
  | { readonly kind: "existing"; readonly attempt: RecordsRequestFaxView };

export type SettleFaxInput =
  | { readonly ok: true; readonly providerMessageId: string }
  | { readonly ok: false; readonly reason: string };

export interface RecordsRequestFaxStore {
  begin(
    organizationId: string,
    actor: RecordsRequestActor,
    input: BeginFaxInput,
  ): Promise<BeginFaxResult>;
  settle(
    organizationId: string,
    actor: RecordsRequestActor,
    attemptId: string,
    result: SettleFaxInput,
  ): Promise<RecordsRequestFaxView>;
  /** The most recent attempt per request (absent = never faxed). */
  latestForRequests(
    organizationId: string,
    requestIds: readonly string[],
  ): Promise<Map<string, RecordsRequestFaxView>>;
}

/** Bounded, PHI-free failure text for the row (a vendor message may be long; it is denylisted anyway). */
export const clampReason = (reason: string): string =>
  reason.trim().slice(0, 500) || "the fax provider refused the fax";

export const faxNotOpen = () =>
  new ChartWardenError(
    "RECORDS_REQUEST_NOT_OPEN",
    "only an open records request (not cancelled or already received) can be faxed",
    409,
  );
export const faxAlreadySent = () =>
  new ChartWardenError(
    "RECORDS_REQUEST_FAX_ALREADY_SENT",
    "this records request was already faxed to a different number",
    409,
  );
export const faxInProgress = () =>
  new ChartWardenError(
    "RECORDS_REQUEST_FAX_IN_PROGRESS",
    "this records request is being faxed right now",
    409,
  );

export interface SendRecordsRequestFaxResult {
  readonly fax: RecordsRequestFaxView;
  /** True when an earlier successful send to the same number was returned instead of dialling again. */
  readonly replayed: boolean;
}

/**
 * Fax a records request's cover sheet + letter. The caller has already checked the referral is visible to
 * the actor and rendered `document` for this request.
 */
export async function sendRecordsRequestFax(
  deps: { readonly store: RecordsRequestFaxStore; readonly transport: OutboundFaxTransport },
  organizationId: string,
  actor: RecordsRequestActor,
  input: {
    readonly request: RecordsRequestView;
    readonly faxNumber: string;
    readonly document: RenderedCoverSheet;
  },
): Promise<SendRecordsRequestFaxResult> {
  const { store, transport } = deps;
  if (!transport.available) {
    throw new DegradedError(
      "outbound-fax",
      transport.unavailableReason ?? "no outbound fax provider is configured",
    );
  }
  const { request, faxNumber, document } = input;
  if (!RECORDS_REQUEST_FAXABLE.has(request.status)) throw faxNotOpen();
  const begun = await store.begin(organizationId, actor, {
    recordsRequestId: request.id,
    referralId: request.referralId,
    patientId: request.patientId,
    faxNumber,
    provider: transport.provider,
    pageCount: document.pageCount,
    documentSha256: document.sha256,
  });
  if (begun.kind === "existing") {
    const a = begun.attempt;
    if (a.status === "sending") throw faxInProgress();
    if (a.faxNumber !== faxNumber) throw faxAlreadySent();
    return { fax: a, replayed: true };
  }
  let result: SettleFaxInput;
  try {
    const sent = await transport.send({
      organizationId,
      to: faxNumber,
      documents: [
        { filename: document.filename, contentType: "application/pdf", bytes: document.bytes },
      ],
      reference: request.requestCode,
      idempotencyKey: begun.attempt.id,
    });
    result = sent.ok
      ? { ok: true, providerMessageId: sent.providerMessageId }
      : { ok: false, reason: clampReason(sent.reason) };
  } catch (err) {
    // A transport that THROWS (network down, vendor 5xx) is a failed attempt, never a 500 that leaves the
    // row `sending`. The error text is not echoed (a vendor message may quote the number).
    result = {
      ok: false,
      reason: `provider error: ${err instanceof Error ? err.name : "unknown"}`,
    };
  }
  return {
    fax: await store.settle(organizationId, actor, begun.attempt.id, result),
    replayed: false,
  };
}

/** In-memory store (route tests). Org-scoped like the RLS-backed one. */
export function createInMemoryRecordsRequestFaxStore(
  opts: { now?: () => Date } = {},
): RecordsRequestFaxStore & {
  readonly rows: Map<string, { org: string; view: RecordsRequestFaxView }>;
} {
  const now = opts.now ?? (() => new Date());
  const rows = new Map<string, { org: string; view: RecordsRequestFaxView }>();
  const live = (org: string, requestId: string) =>
    [...rows.values()].find(
      (r) =>
        r.org === org &&
        r.view.recordsRequestId === requestId &&
        (r.view.status === "sending" || r.view.status === "sent"),
    );
  const settleRow = (id: string, result: SettleFaxInput) => {
    const r = rows.get(id);
    if (!r) throw new NotFoundError("records_request_fax");
    const at = now().toISOString();
    r.view = result.ok
      ? { ...r.view, status: "sent", providerMessageId: result.providerMessageId, sentAt: at }
      : { ...r.view, status: "failed", failureReason: clampReason(result.reason), failedAt: at };
    return r.view;
  };
  return {
    rows,
    async begin(organizationId, _actor, input) {
      const existing = live(organizationId, input.recordsRequestId);
      if (existing) {
        const stale =
          existing.view.status === "sending" &&
          now().getTime() - Date.parse(existing.view.attemptedAt) > FAX_SENDING_STALE_AFTER_MS;
        if (!stale) return { kind: "existing", attempt: existing.view };
        settleRow(existing.view.id, { ok: false, reason: FAX_INTERRUPTED_REASON });
      }
      const view: RecordsRequestFaxView = {
        id: randomUUID(),
        recordsRequestId: input.recordsRequestId,
        faxNumber: input.faxNumber,
        status: "sending",
        provider: input.provider,
        providerMessageId: null,
        pageCount: input.pageCount,
        failureReason: null,
        attemptedAt: now().toISOString(),
        sentAt: null,
        failedAt: null,
      };
      rows.set(view.id, { org: organizationId, view });
      return { kind: "started", attempt: view };
    },
    async settle(organizationId, _actor, attemptId, result) {
      const r = rows.get(attemptId);
      if (!r || r.org !== organizationId) throw new NotFoundError("records_request_fax");
      return settleRow(attemptId, result);
    },
    async latestForRequests(organizationId, requestIds) {
      const out = new Map<string, RecordsRequestFaxView>();
      const ids = new Set(requestIds);
      for (const r of rows.values()) {
        if (r.org !== organizationId || !ids.has(r.view.recordsRequestId)) continue;
        const prev = out.get(r.view.recordsRequestId);
        if (!prev || prev.attemptedAt <= r.view.attemptedAt)
          out.set(r.view.recordsRequestId, r.view);
      }
      return out;
    },
  };
}
