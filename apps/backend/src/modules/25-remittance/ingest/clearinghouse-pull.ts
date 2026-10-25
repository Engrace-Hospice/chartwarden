// apps/backend/src/modules/25-remittance/ingest/clearinghouse-pull.ts - #717 (plan item A5): the bound clearinghouse
// transport's `fetchRemittances` feeding the M25 835 receive/post pipeline. For each credentialed provider entity it
// resumes from the persisted cursor, pages the transport, and hands every 835 to `receiveAdvice` (which dedups on the
// ISA13/ST02 control numbers, stages the raw text and emits `m25.edi.835_received`; the live consumer then posts).
//
// Failure posture (no silent loss, no silent restart):
//   - a cursor the transport refuses (malformed, or beyond the end) is reported and the stored cursor is LEFT AS IS; it is
//     never reset to null, because a null cursor re-reads the whole chain.
//   - a file `receiveAdvice` calls malformed stops the chain at that page: the cursor is not moved past it, so the file is
//     re-offered on the next tick and surfaces as a failure until the vendor or an operator settles it.
//   - the cursor moves only after every file of a page was received (queued or duplicate).
// The transport is a structural view (M25 does not import the M23/transport wiring); the composition root supplies it.
import { createHash } from "node:crypto";
import type { ClearinghouseContext, ClearinghouseTransport } from "@chartwarden/x12-837-client";
import { CH } from "@chartwarden/x12-837-client";
import type { M25IngestService } from "./service";

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
  for (const providerEntityId of await deps.contexts.providerEntitiesFor(organizationId)) {
    const label = `org ${organizationId} provider ${providerEntityId}`;
    try {
      const counts = await pullOne(deps, organizationId, providerEntityId);
      if (counts === "unsupported") unsupported += 1;
      else {
        queued += counts.queued;
        duplicates += counts.duplicates;
      }
    } catch (err) {
      failures.push(`${label}: ${err instanceof Error ? err.message : "failed"}`);
    }
  }
  return { queued, duplicates, unsupported, failures };
}

async function pullOne(
  deps: RemittancePullDeps,
  organizationId: string,
  providerEntityId: string,
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
      const refused = result.degraded.code === CH.INVALID_REQUEST;
      throw new Error(
        `${refused ? "remittance cursor refused (not reset)" : "remittance pull"}: ${result.degraded.code} ${result.degraded.reason}`,
      );
    }
    for (const file of result.data.items) {
      const received = await deps.ingest.receiveAdvice(
        { organizationId },
        {
          providerEntityId,
          payerId,
          payerKind: "medicare",
          minioObjectKey: `clearinghouse/${deps.vendor}/${file.remittanceId}`,
          fileSha256: sha256(file.rawX12),
          rawEdi: file.rawX12,
        },
      );
      if (received.outcome === "malformed") {
        throw new Error(`remittance ${file.remittanceId} refused at receive: ${received.reason}`);
      }
      if (received.outcome === "queued") queued += 1;
      else duplicates += 1;
    }
    await deps.cursors.set(key, result.data.nextCursor);
    if (!result.data.hasMore) break;
    cursor = result.data.nextCursor;
  }
  return { queued, duplicates };
}
