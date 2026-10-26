// M23 — the submit workers' 837I render step for a clearinghouse-bound deployment: load the persisted claim through the
// loader (real parties, subscriber, lines) and return the X12 to hand the transport. It replaces the sidecar's thin
// `claimDocumentFor` document on that path; there is NO fallback to it. A loader gap THROWS an error naming the gaps
// (field and reason only, never a value), which the caller's catch records as a `failed_worker` attempt.
import type { repositories } from "@chartwarden/billing";
import type { DbClient } from "@chartwarden/db";
import type { ClearinghouseContext, StediClaimJson } from "@chartwarden/x12-837-client";
import {
  type Claim837iLoaderDeps,
  buildClaim837iPersistencePort,
  loadAndRender837i,
} from "./claim-837i-loader";

/** What the workers bind beyond the claim persistence (which is built per job on the worker's tx). */
export type Claim837iSubmitDeps = Omit<Claim837iLoaderDeps, "persistence" | "parties"> & {
  /** The parties port for one worker tx (its reads share that tx, not the pool). */
  readonly parties: (tx: DbClient) => Claim837iLoaderDeps["parties"];
};

/** Both renderings of one claim; each carries the MBI, so transmit them and never store or log them. */
export interface RenderedClaim {
  readonly x12: string;
  /** Absent only from a test stub; the loader always builds it. */
  readonly stediJson?: StediClaimJson;
}

export async function renderClaimForTransport(args: {
  readonly tx: repositories.BillingDb;
  readonly deps: Claim837iSubmitDeps;
  readonly contextFor: (
    organizationId: string,
    providerEntityId: string,
  ) => Promise<ClearinghouseContext>;
  readonly organizationId: string;
  readonly claim: { readonly id: string; readonly providerEntityId: string };
  readonly claimControlNumber: string;
  /**
   * The ISA13 for this submission. The caller (the worker) owns the key it is remembered under, so a redelivered job
   * renders the identical interchange; the number is never derived here.
   */
  readonly interchangeNumberFor: (context: ClearinghouseContext) => Promise<number>;
  readonly now: Date;
}): Promise<RenderedClaim> {
  const context = await args.contextFor(args.organizationId, args.claim.providerEntityId);
  const loaded = await loadAndRender837i(
    {
      ...args.deps,
      persistence: buildClaim837iPersistencePort(args.tx),
      parties: args.deps.parties(args.tx as unknown as DbClient),
    },
    {
      claimId: args.claim.id,
      context,
      interchangeControlNumber: await args.interchangeNumberFor(context),
      createdAt: args.now,
      claimControlNumber: args.claimControlNumber,
    },
  );
  if (loaded.ok) return loaded.rendered.reveal();
  const why =
    loaded.kind === "claim_not_found"
      ? "claim not found for this organization and provider entity"
      : loaded.gaps.map((g) => `${g.field} (${g.reason})`).join(", ");
  throw new Error(`claim ${args.claim.id} 837I is not sendable: ${why}`);
}
