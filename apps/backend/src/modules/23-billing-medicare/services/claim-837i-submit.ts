// M23 — the submit workers' 837I render step for a clearinghouse-bound deployment: load the persisted claim through the
// loader (real parties, subscriber, lines) and return the X12 to hand the transport. It replaces the sidecar's thin
// `claimDocumentFor` document on that path; there is NO fallback to it. A loader gap THROWS an error naming the gaps
// (field and reason only, never a value), which the caller's catch records as a `failed_worker` attempt.
import { createHash } from "node:crypto";
import type { repositories } from "@chartwarden/billing";
import type { ClearinghouseContext } from "@chartwarden/x12-837-client";
import {
  type Claim837iLoaderDeps,
  buildClaim837iPersistencePort,
  loadAndRender837i,
} from "./claim-837i-loader";

/** What the workers bind beyond the claim persistence (which is built per job on the worker's tx). */
export type Claim837iSubmitDeps = Omit<Claim837iLoaderDeps, "persistence">;

/** ISA13 is 1..999 999 999. */
const MAX_INTERCHANGE_CONTROL_NUMBER = 999_999_999;

/**
 * The interchange control number for one attempt, derived from its claim control number so a redelivered attempt renders
 * the identical interchange (the transport's idempotency key is the control number). A 32-bit hash into 1e9 slots: the
 * exposure is birthday-shaped, so it grows with a receiver's lifetime volume (about one colliding pair in ~45k attempts).
 * A receiver that enforces ISA13 uniqueness would reject that interchange (TA1 025); the retry derives a new control
 * number and so a new ISA13. Confirm the vendor/MAC does not enforce uniqueness, or replace this with a persisted
 * per-sender counter, before relying on it at volume.
 */
export function interchangeNumberFor(claimControlNumber: string): number {
  const word = createHash("sha256").update(claimControlNumber).digest().readUInt32BE(0);
  return (word % MAX_INTERCHANGE_CONTROL_NUMBER) + 1;
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
  readonly now: Date;
}): Promise<string> {
  const context = await args.contextFor(args.organizationId, args.claim.providerEntityId);
  const loaded = await loadAndRender837i(
    { ...args.deps, persistence: buildClaim837iPersistencePort(args.tx) },
    {
      claimId: args.claim.id,
      context,
      interchangeControlNumber: interchangeNumberFor(args.claimControlNumber),
      createdAt: args.now,
      claimControlNumber: args.claimControlNumber,
    },
  );
  if (loaded.ok) return loaded.rendered.reveal().x12;
  const why =
    loaded.kind === "claim_not_found"
      ? "claim not found for this organization and provider entity"
      : loaded.gaps.map((g) => `${g.field} (${g.reason})`).join(", ");
  throw new Error(`claim ${args.claim.id} 837I is not sendable: ${why}`);
}
