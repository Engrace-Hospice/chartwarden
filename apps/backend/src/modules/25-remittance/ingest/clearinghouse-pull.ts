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
//     A file whose functional group M25 cannot route (`unsupported`) is the same kind of refusal (its content will not change
//     on a retry), recorded under its own reason code so it cannot pin the cursor forever.
//   - a file the pipeline HOLDS rather than posts (`held_duplicate`, `review_required`) is received (the cursor moves on) but is
//     not a duplicate: it is reported under `held` (id and code only) so an operator sees it.
//   - the cursor moves only after every file of a page was received (queued or duplicate).
// The transport is a structural view (M25 does not import the M23/transport wiring); the composition root supplies it.
import { createHash } from "node:crypto";
import { ChartWardenError } from "@chartwarden/types";
import type { ClearinghouseContext, ClearinghouseTransport } from "@chartwarden/x12-837-client";
import { CH, cursorVendorKey } from "@chartwarden/x12-837-client";
import type { M25IngestService } from "./service";

/** Consecutive refusals of one remittance file before it is quarantined and the cursor advances past it. */
export const MAX_REFUSALS_PER_REMITTANCE = 5;

/** Failure-reason code for a quarantined file. */
export const REMITTANCE_QUARANTINED = "REMITTANCE_QUARANTINED";
const RECEIVE_REFUSED = "RECEIVE_REFUSED";
const UNSUPPORTED_ROUTING = "UNSUPPORTED_ROUTING";

/** Safety bound on one chain walk per provider entity per tick (the next tick continues from the stored cursor). */
export const MAX_REMITTANCE_PAGES = 100;

export interface RemittancePullContexts {
  providerEntitiesFor(organizationId: string): Promise<readonly string[]>;
  /** `payerRoute: "skip"`: a remittance feed is not addressed to a payer, so no Claim.MD payer route is resolved for it. */
  contextFor(
    organizationId: string,
    providerEntityId: string,
    options?: { readonly payerRoute?: "skip" },
  ): Promise<ClearinghouseContext>;
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
  /**
   * Quarantined files of this key, by reason code (`UNSUPPORTED_ROUTING`, `RECEIVE_REFUSED`). Durable: a quarantined file is
   * never re-offered once the cursor has moved past it, so this is the only standing signal that money is waiting on an operator.
   */
  quarantineBacklog(key: RemittanceCursorKey): Promise<Readonly<Record<string, number>>>;
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

/** One organization's clearinghouse as the pull needs it. `vendor` null = the organization has none: it is skipped (no call, no failure). */
export interface RemittancePullBinding {
  readonly transport: ClearinghouseTransport;
  readonly vendor: string | null;
  /** `tenant` on the org's OWN account: its cursor is kept apart from the platform account's. */
  readonly account?: "tenant";
  /** Set on an unbound binding (`vendor` null): why. `baa_revoked` makes the pull report that responses may still be owed. */
  readonly unboundReason?: string;
}

/**
 * The clearinghouse the pull reads from: ONE platform binding (`transport` + `vendor`), or a binding PER ORGANIZATION (`forOrg`, the
 * tenant clearinghouse, ADR-0053 amendment 2026-11-06), resolved inside the per-org loop. With `forOrg` there is no platform pair.
 */
export type RemittancePullDeps = {
  readonly contexts: RemittancePullContexts;
  readonly payers: MedicarePayerPort;
  readonly cursors: RemittanceCursorStore;
  readonly ingest: Pick<M25IngestService, "receiveAdvice">;
  /**
   * An organization whose vendor BAA a platform operator revoked is skipped by this pull (it has no live clearinghouse), so a
   * remittance the vendor still holds for claims it already sent would sit unseen. This is called, at most once per organization per
   * tick, for such an organization; the composition root raises the "responses may still be owed" alert when any are. Must not throw
   * into the pull: a failure is swallowed here (the pull carries on with the next organization).
   */
  readonly onRevokedSkipped?: (organizationId: string) => Promise<void>;
} & (
  | {
      readonly transport: ClearinghouseTransport;
      readonly vendor: string;
      readonly forOrg?: undefined;
    }
  | {
      readonly forOrg: (organizationId: string) => Promise<RemittancePullBinding>;
      readonly transport?: undefined;
      readonly vendor?: undefined;
    }
);

/** The binding to pull this organization's remittances through; null when it has no usable clearinghouse. */
type PullBinding = {
  readonly transport: ClearinghouseTransport;
  readonly vendor: string;
  readonly account?: "tenant";
};

/** The org's binding, or `null` plus why it has none (`unboundReason`: an unbound binding says so, e.g. `baa_revoked`). */
async function bindingOf(
  deps: RemittancePullDeps,
  organizationId: string,
): Promise<{ readonly binding: PullBinding | null; readonly unboundReason?: string }> {
  const bound: RemittancePullBinding = deps.forOrg
    ? await deps.forOrg(organizationId)
    : { transport: deps.transport, vendor: deps.vendor };
  if (bound.vendor === null) {
    return {
      binding: null,
      ...(bound.unboundReason ? { unboundReason: bound.unboundReason } : {}),
    };
  }
  return {
    binding: {
      transport: bound.transport,
      vendor: bound.vendor,
      ...(bound.account ? { account: bound.account } : {}),
    },
  };
}

export interface RemittancePullResult {
  readonly queued: number;
  readonly duplicates: number;
  /** Provider entities whose transport has no 835 feed in this build (CH_NOT_WIRED): skipped, not failed (real feeds: #253). */
  readonly unsupported: number;
  /** Quarantined files offered this tick (new and still-quarantined) (`<label>: remittance <id> REMITTANCE_QUARANTINED`); ids and a code only. */
  readonly quarantined: readonly string[];
  /**
   * Files received but held for an operator instead of posted (`held_duplicate`: a legacy GS06-less row has the same ISA13/ST02;
   * `review_required`: a staged Claim.MD ERA matches): `<label>: remittance <id> <CODE>`. Ids and a code only. These are not in `duplicates`.
   */
  readonly held: readonly string[];
  /**
   * Standing quarantine per provider entity (`<label>: <n> quarantined remittance(s) awaiting operator release (<REASON>=<n>, ...)`),
   * reported every tick until an operator releases the files. A quarantined file is never re-offered once the cursor has moved
   * past it, so `quarantined` alone is a one-tick signal. Counts and codes only.
   */
  readonly backlog: readonly string[];
  /** PHI-free: ids and codes only, never file content. */
  readonly failures: readonly string[];
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** A PHI-free label for a failure: a typed refusal's stable code, else the error's class name. */
const errorClassOf = (err: unknown): string =>
  err instanceof ChartWardenError ? err.code : err instanceof Error ? err.name : "unknown";

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
  const held: string[] = [];
  const backlog: string[] = [];
  let binding: PullBinding | null;
  try {
    const resolved = await bindingOf(deps, organizationId);
    binding = resolved.binding;
    // A revoked BAA is not a silent skip: the vendor may still hold responses for claims already sent, so say so (best effort).
    if (binding === null && resolved.unboundReason === "baa_revoked") {
      try {
        await deps.onRevokedSkipped?.(organizationId);
      } catch {
        // best effort: the report must never stop the pull (or turn a skip into a failure)
      }
    }
  } catch (err) {
    // The error CLASS only (a typed refusal's code, else the class name): the cause text could carry anything, and this string
    // reaches job data and logs. Without it a tenant whose credential is unreadable and one whose config read failed look alike.
    return {
      queued,
      duplicates,
      unsupported,
      quarantined,
      held,
      backlog,
      failures: [
        `org ${organizationId}: clearinghouse binding could not be resolved (${errorClassOf(err)})`,
      ],
    };
  }
  // No clearinghouse of its own (billing outside ChartWarden, or none chosen yet): nothing to pull, nothing failed.
  if (binding === null)
    return { queued, duplicates, unsupported, quarantined, held, backlog, failures };
  let providerEntityIds: readonly string[];
  try {
    providerEntityIds = await deps.contexts.providerEntitiesFor(organizationId);
  } catch {
    return {
      queued,
      duplicates,
      unsupported,
      quarantined,
      held,
      backlog,
      failures: [`org ${organizationId}: provider entities could not be listed`],
    };
  }
  for (const providerEntityId of providerEntityIds) {
    const label = `org ${organizationId} provider ${providerEntityId}`;
    try {
      const counts = await pullOne(
        deps,
        binding,
        organizationId,
        providerEntityId,
        label,
        quarantined,
        held,
        backlog,
      );
      if (counts === "unsupported") unsupported += 1;
      else {
        queued += counts.queued;
        duplicates += counts.duplicates;
      }
    } catch (err) {
      failures.push(`${label}: ${err instanceof Error ? err.message : "failed"}`);
    }
  }
  return { queued, duplicates, unsupported, quarantined, held, backlog, failures };
}

async function pullOne(
  deps: RemittancePullDeps,
  binding: PullBinding,
  organizationId: string,
  providerEntityId: string,
  label: string,
  quarantined: string[],
  held: string[],
  backlog: string[],
): Promise<{ queued: number; duplicates: number } | "unsupported"> {
  const ctx = await deps.contexts.contextFor(organizationId, providerEntityId, {
    payerRoute: "skip",
  });
  const payerId = await deps.payers.medicarePayerId(organizationId);
  if (!payerId) throw new Error("the Medicare payer is not resolvable in the payer directory");
  const key: RemittanceCursorKey = {
    organizationId,
    providerEntityId,
    vendor: cursorVendorKey(binding),
    usage: ctx.usage,
  };
  let cursor = await deps.cursors.get(key);
  let queued = 0;
  let duplicates = 0;
  for (let page = 0; page < MAX_REMITTANCE_PAGES; page++) {
    const result = await binding.transport.fetchRemittances(ctx, cursor);
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
          objectKey: `clearinghouse/${binding.vendor}/${file.remittanceId}`,
          fileSha256,
          rawEdi: file.rawX12,
        },
      );
      if (received.outcome === "malformed" || received.outcome === "unsupported") {
        // Only a refusal that is a property of the file counts: its own content (`malformed` + cause "content") or a valid
        // interchange shape M25 cannot route (`unsupported`); neither changes on a retry. Config / parser outages stay
        // transient (retried, uncapped). A counted refusal is capped like any other, so an unroutable file cannot pin the
        // cursor forever: after the cap it is quarantined and the chain continues.
        const unroutable = received.outcome === "unsupported";
        if (!unroutable && received.cause !== "content") {
          throw new Error(`remittance ${file.remittanceId} refused at receive`);
        }
        const refusal = await deps.cursors.recordRefusal(
          key,
          file.remittanceId,
          fileSha256,
          unroutable ? UNSUPPORTED_ROUTING : RECEIVE_REFUSED,
          MAX_REFUSALS_PER_REMITTANCE,
        );
        if (!refusal.quarantined) {
          throw new Error(
            unroutable
              ? `remittance ${file.remittanceId} has unsupported X12 group routing`
              : `remittance ${file.remittanceId} refused at receive`,
          );
        }
        quarantined.push(`${label}: remittance ${file.remittanceId} ${REMITTANCE_QUARANTINED}`);
        continue;
      }
      await deps.cursors.clearRefusals(key, file.remittanceId, fileSha256);
      if (received.outcome === "queued") queued += 1;
      else if (received.outcome === "duplicate") duplicates += 1;
      // A multi-set file answers with one outcome: `heldSets` lists every held set (beside a queued/duplicate set,
      // or several held ones), and a lone held set is the outcome itself.
      const heldReasons =
        received.heldSets ??
        (received.outcome === "held_duplicate" || received.outcome === "review_required"
          ? [received.reason]
          : []);
      for (const reason of heldReasons)
        held.push(`${label}: remittance ${file.remittanceId} ${reason}`);
    }
    if (result.data.nextCursor !== cursor) await deps.cursors.set(key, result.data.nextCursor);
    if (!result.data.hasMore) {
      const standing = await deps.cursors.quarantineBacklog(key);
      const total = Object.values(standing).reduce((sum, n) => sum + n, 0);
      if (total > 0) {
        const byReason = Object.entries(standing)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([reason, n]) => `${reason}=${n}`)
          .join(", ");
        backlog.push(
          `${label}: ${total} quarantined remittance(s) awaiting operator release (${byReason})`,
        );
      }
      return { queued, duplicates };
    }
    cursor = result.data.nextCursor;
  }
  // Page bound reached with more waiting: the next tick resumes from the stored cursor.
  throw new Error(
    `remittance chain exceeds ${MAX_REMITTANCE_PAGES} pages in one tick; resuming next tick`,
  );
}
