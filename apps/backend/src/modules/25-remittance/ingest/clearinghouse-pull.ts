// apps/backend/src/modules/25-remittance/ingest/clearinghouse-pull.ts - #717 (plan item A5): the bound clearinghouse
// transport's `fetchRemittances` feeding the M25 835 receive/post pipeline. For each credentialed provider entity it
// resumes from the persisted cursor, pages the transport, and hands every 835 to `receiveAdvice` (which dedups on the
// ISA13/ST02 control numbers, stages the raw text and emits `m25.edi.835_received`; the live consumer then posts).
//
// Failure posture (no silent loss, no silent restart):
//   - a cursor the transport refuses (malformed, or beyond the end) is reported and the stored cursor is LEFT AS IS; it is
//     never reset to null, because a null cursor re-reads the whole chain.
//   - a file `receiveAdvice` calls malformed stops the chain at that page: the cursor is not moved past it, so the file is
//     re-offered on the next tick (a transient refusal retries). After MAX_REFUSALS_PER_REMITTANCE refusals of the same
//     file it (same content hash) is quarantined (durable `remittance_pull_refusal` row), skipped, and the cursor moves on; the tick reports
//     it under `quarantined` with the explicit code REMITTANCE_QUARANTINED (ids only, never vendor text or content).
//   - the cursor moves only after every file of a page was received (queued or duplicate).
// The transport is a structural view (M25 does not import the M23/transport wiring); the composition root supplies it.
import { createHash } from "node:crypto";
import type { ClearinghouseContext, ClearinghouseTransport } from "@chartwarden/x12-837-client";
import { CH } from "@chartwarden/x12-837-client";
import type { M25IngestService } from "./service";

/** Consecutive refusals of one remittance file before it is quarantined and the cursor advances past it. */
export const MAX_REFUSALS_PER_REMITTANCE = 5;

/** Failure-reason code for a quarantined file. */
export const REMITTANCE_QUARANTINED = "REMITTANCE_QUARANTINED";
const RECEIVE_REFUSED = "RECEIVE_REFUSED";

/** Safety bound on one chain walk per provider entity per tick (the next tick continues from the stored cursor). */
export const MAX_REMITTANCE_PAGES = 100;

export interface RemittancePullContexts {
  providerEntitiesFor(organizationId: string): Promise<readonly string[]>;
  contextFor(organizationId: string, providerEntityId: string): Promise<ClearinghouseContext>;
}

/** The Medicare payer's id in this tenant's payer directory (M40), or null when it cannot be resolved. */
export interface MedicarePayerPort {
  medicarePayerId(organizationId: string): Promise<string | null>;
}

export interface RemittanceCursorKey {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly vendor: string;
  readonly usage: ClearinghouseContext["usage"];
}

export interface RemittanceCursorStore {
  get(key: RemittanceCursorKey): Promise<string | null>;
  set(key: RemittanceCursorKey, cursor: string): Promise<void>;
  isQuarantined(
    key: RemittanceCursorKey,
    remittanceId: string,
    fileSha256: string,
  ): Promise<boolean>;
  /** The file was accepted: zero its not-yet-quarantined refusal count so the cap means CONSECUTIVE refusals. */
  clearRefusals(key: RemittanceCursorKey, remittanceId: string, fileSha256: string): Promise<void>;
  /** Count one more refusal of this file (durable); `quarantined` once `count >= cap`. Code only: no vendor text. */
  recordRefusal(
    key: RemittanceCursorKey,
    remittanceId: string,
    fileSha256: string,
    reasonCode: string,
    cap: number,
  ): Promise<{ readonly count: number; readonly quarantined: boolean }>;
}

export interface RemittancePullDeps {
  readonly transport: ClearinghouseTransport;
  readonly vendor: string;
  readonly contexts: RemittancePullContexts;
  readonly payers: MedicarePayerPort;
  readonly cursors: RemittanceCursorStore;
  readonly ingest: Pick<M25IngestService, "receiveAdvice">;
}

export interface RemittancePullResult {
  readonly queued: number;
  readonly duplicates: number;
  /** Provider entities whose transport has no 835 feed in this build (CH_NOT_WIRED): skipped, not failed (real feeds: #253). */
  readonly unsupported: number;
  /** Quarantined files offered this tick (new and still-quarantined) (`<label>: remittance <id> REMITTANCE_QUARANTINED`); ids and a code only. */
  readonly quarantined: readonly string[];
  /** PHI-free: ids and codes only, never file content. */
  readonly failures: readonly string[];
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** Pull and receive every pending remittance for one org. A failing provider entity does not stop the others. */
export async function pullRemittances(
  deps: RemittancePullDeps,
  organizationId: string,
): Promise<RemittancePullResult> {
  let queued = 0;
  let duplicates = 0;
  let unsupported = 0;
  const failures: string[] = [];
  const quarantined: string[] = [];
  let providerEntityIds: readonly string[];
  try {
    providerEntityIds = await deps.contexts.providerEntitiesFor(organizationId);
  } catch {
    return {
      queued,
      duplicates,
      unsupported,
      quarantined,
      failures: [`org ${organizationId}: provider entities could not be listed`],
    };
  }
  for (const providerEntityId of providerEntityIds) {
    const label = `org ${organizationId} provider ${providerEntityId}`;
    try {
      const counts = await pullOne(deps, organizationId, providerEntityId, label, quarantined);
      if (counts === "unsupported") unsupported += 1;
      else {
        queued += counts.queued;
        duplicates += counts.duplicates;
      }
    } catch (err) {
      failures.push(`${label}: ${err instanceof Error ? err.message : "failed"}`);
    }
  }
  return { queued, duplicates, unsupported, quarantined, failures };
}

async function pullOne(
  deps: RemittancePullDeps,
  organizationId: string,
  providerEntityId: string,
  label: string,
  quarantined: string[],
): Promise<{ queued: number; duplicates: number } | "unsupported"> {
  const ctx = await deps.contexts.contextFor(organizationId, providerEntityId);
  const payerId = await deps.payers.medicarePayerId(organizationId);
  if (!payerId) throw new Error("the Medicare payer is not resolvable in the payer directory");
  const key: RemittanceCursorKey = {
    organizationId,
    providerEntityId,
    vendor: deps.vendor,
    usage: ctx.usage,
  };
  let cursor = await deps.cursors.get(key);
  let queued = 0;
  let duplicates = 0;
  for (let page = 0; page < MAX_REMITTANCE_PAGES; page++) {
    const result = await deps.transport.fetchRemittances(ctx, cursor);
    if (!result.ok) {
      if (result.degraded.code === CH.NOT_WIRED) return "unsupported";
      // Code only: the vendor's reason text is not provably PHI-free and this string reaches job data and logs.
      const refused = result.degraded.code === CH.INVALID_REQUEST;
      throw new Error(
        `${refused ? "remittance request refused (cursor not reset)" : "remittance pull"}: ${result.degraded.code}`,
      );
    }
    for (const file of result.data.items) {
      const fileSha256 = sha256(file.rawX12);
      // A quarantined file is skipped but reported on every tick it is still offered; a CHANGED file (new hash) is retried.
      if (await deps.cursors.isQuarantined(key, file.remittanceId, fileSha256)) {
        quarantined.push(`${label}: remittance ${file.remittanceId} ${REMITTANCE_QUARANTINED}`);
        continue;
      }
      const received = await deps.ingest.receiveAdvice(
        { organizationId },
        {
          providerEntityId,
          payerId,
          payerKind: "medicare",
          minioObjectKey: `clearinghouse/${deps.vendor}/${file.remittanceId}`,
          fileSha256,
          rawEdi: file.rawX12,
        },
      );
      if (received.outcome === "malformed") {
        // Only a refusal caused by the file's own content counts; config / parser outages stay transient (retried, uncapped).
        if (received.cause !== "content") {
          throw new Error(`remittance ${file.remittanceId} refused at receive`);
        }
        const refusal = await deps.cursors.recordRefusal(
          key,
          file.remittanceId,
          fileSha256,
          RECEIVE_REFUSED,
          MAX_REFUSALS_PER_REMITTANCE,
        );
        if (!refusal.quarantined) {
          throw new Error(`remittance ${file.remittanceId} refused at receive`);
        }
        quarantined.push(`${label}: remittance ${file.remittanceId} ${REMITTANCE_QUARANTINED}`);
        continue;
      }
      await deps.cursors.clearRefusals(key, file.remittanceId, fileSha256);
      if (received.outcome === "queued") queued += 1;
      else duplicates += 1;
    }
    if (result.data.nextCursor !== cursor) await deps.cursors.set(key, result.data.nextCursor);
    if (!result.data.hasMore) return { queued, duplicates };
    cursor = result.data.nextCursor;
  }
  // Page bound reached with more waiting: the next tick resumes from the stored cursor.
  throw new Error(
    `remittance chain exceeds ${MAX_REMITTANCE_PAGES} pages in one tick; resuming next tick`,
  );
}
