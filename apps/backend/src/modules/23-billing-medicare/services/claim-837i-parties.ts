// M23 — the production `Claim837iPartiesPort` (the loader's party source). Nothing is invented: every section the
// sources cannot fully supply is `null`, which the loader reports as a typed gap.
//   • submitter + receiver (1000A/B, GS03): M23's own `billing_edi_profile`, keyed by (provider entity, route), where the
//     route is the bound CLEARINGHOUSE_VENDOR. No bound route, or no row for it, is null for both.
//   • billing provider (2010AA): M1's `provider_entity` through an injected reader (`buildClaim837iProviderReader` opens
//     the sealed EIN through an injected decrypt, so this module never touches the cipher or M1's table).
//   • payer (2010BB): the payer's X12 name through an injected reader keyed by the clearinghouse payer id.
import { type DbClient, schema } from "@chartwarden/db";
import { and, eq } from "drizzle-orm";
import type { Claim837iPartiesPort } from "./claim-837i-loader";
import type { Claim837iParties } from "./claim-837i-mapper";

type Parties = Awaited<ReturnType<Claim837iPartiesPort["partiesFor"]>>;
type BillingProvider = NonNullable<Parties["billingProvider"]>;

/** The tenant-entered interchange parties for one (provider entity, route). */
export interface EdiProfileFacts {
  readonly submitter: NonNullable<Parties["submitter"]>;
  readonly receiver: NonNullable<Parties["receiver"]>;
}

/** The provider entity's billing facts as stored; the EIN is already decrypted, the address still unvalidated. */
export interface ProviderBillingFacts {
  readonly legalName: string;
  readonly npi: string;
  readonly taxId: string;
  readonly address: unknown;
}

/**
 * Every read runs on the CALLER'S transaction (the submit worker's per-job tx). A read that opened its own
 * `withOrgContext` would take a second pooled connection while the worker already holds one, which can starve the pool
 * when every submit worker is mid-job.
 */
export type PartiesTx = DbClient;

export interface Claim837iPartiesDeps {
  /** The bound `CLEARINGHOUSE_VENDOR`, or null when unbound (then submitter and receiver are gaps). */
  readonly routeKey: string | null;
  readonly profile: (
    tx: PartiesTx,
    organizationId: string,
    providerEntityId: string,
    routeKey: string,
  ) => Promise<EdiProfileFacts | null>;
  readonly provider: (
    tx: PartiesTx,
    organizationId: string,
    providerEntityId: string,
  ) => Promise<ProviderBillingFacts | null>;
  /** The payer's name for an X12 payer id, or null when the payer is unknown. */
  readonly payerName: (tx: PartiesTx, x12PayerId: string) => Promise<string | null>;
}

const EIN_PATTERN = /^\d{9}$/;
const STATE_PATTERN = /^[A-Za-z]{2}$/;

const nonBlank = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/**
 * The billing address from a provider entity's `addresses` jsonb: the FIRST entry (the one M2's billing-address PATCH
 * writes and its detail view reads), and only if it carries every required X12 field (line1, city, a 2-letter state,
 * postalCode). A partial address is null, never completed, and a later entry is never substituted for it.
 */
export function billingAddressFrom(addresses: unknown): BillingProvider["address"] | null {
  if (!Array.isArray(addresses)) return null;
  const a = addresses[0] as Record<string, unknown> | undefined;
  if (
    !a ||
    !nonBlank(a.line1) ||
    !nonBlank(a.city) ||
    !nonBlank(a.state) ||
    !STATE_PATTERN.test(a.state.trim()) ||
    !nonBlank(a.postalCode)
  ) {
    return null;
  }
  return {
    line1: a.line1.trim(),
    ...(nonBlank(a.line2) ? { line2: a.line2.trim() } : {}),
    city: a.city.trim(),
    state: a.state.trim().toUpperCase(),
    postalCode: a.postalCode.trim(),
  };
}

/** The sealed provider facts M1 publishes (`FoundationSiteReader.providerEntityBillingFacts`), bound to one org tx. */
export interface SealedProviderFacts {
  readonly legalName: string;
  readonly npi: string;
  readonly taxIdSealed: string;
  readonly addresses: unknown;
}

/** Composes M1's sealed read with M2's tax-id decrypt (both injected) into the parties port's `provider` source. */
export function buildClaim837iProviderReader(deps: {
  readonly sealedFacts: (
    tx: PartiesTx,
    organizationId: string,
    providerEntityId: string,
  ) => Promise<SealedProviderFacts | null>;
  readonly decryptTaxId: (input: {
    organizationId: string;
    providerEntityId: string;
    sealed: string;
  }) => Promise<string>;
}): Claim837iPartiesDeps["provider"] {
  return async (tx, organizationId, providerEntityId) => {
    const facts = await deps.sealedFacts(tx, organizationId, providerEntityId);
    if (!facts) return null;
    const taxId = await deps.decryptTaxId({
      organizationId,
      providerEntityId,
      sealed: facts.taxIdSealed,
    });
    return { legalName: facts.legalName, npi: facts.npi, taxId, address: facts.addresses };
  };
}

function billingProviderFrom(facts: ProviderBillingFacts | null): Parties["billingProvider"] {
  if (!facts) return null;
  const taxId = facts.taxId.replace("-", "");
  const address = billingAddressFrom(facts.address);
  if (!nonBlank(facts.legalName) || !nonBlank(facts.npi) || !EIN_PATTERN.test(taxId) || !address) {
    return null;
  }
  return { organizationName: facts.legalName.trim(), npi: facts.npi, taxId, address };
}

/** The port for one worker transaction; its three reads run in sequence on that tx. */
export function buildClaim837iPartiesPortFactory(
  deps: Claim837iPartiesDeps,
): (tx: PartiesTx) => Claim837iPartiesPort {
  return (tx) => ({
    async partiesFor({ organizationId, providerEntityId, payerId }) {
      const profile = deps.routeKey
        ? await deps.profile(tx, organizationId, providerEntityId, deps.routeKey)
        : null;
      const provider = await deps.provider(tx, organizationId, providerEntityId);
      const payerName = await deps.payerName(tx, payerId);
      return {
        submitter: profile?.submitter ?? null,
        receiver: profile?.receiver ?? null,
        billingProvider: billingProviderFrom(provider),
        payer: nonBlank(payerName) ? { name: payerName.trim(), payerId } : null,
      };
    },
  });
}

/** `billing_edi_profile` as the loader reads it, on the caller's org-scoped transaction (RLS applies). */
export function buildDrizzleEdiProfileReader(): Claim837iPartiesDeps["profile"] {
  const t = schema.billingEdiProfile;
  return async (tx, organizationId, providerEntityId, routeKey) => {
    const [row] = await tx
      .select()
      .from(t)
      .where(
        and(
          eq(t.organizationId, organizationId),
          eq(t.providerEntityId, providerEntityId),
          eq(t.routeKey, routeKey),
        ),
      )
      .limit(1);
    if (!row) return null;
    const receiver: Claim837iParties["receiver"] = {
      name: row.receiverName,
      id: row.receiverId,
      applicationCode: row.receiverApplicationCode,
    };
    return {
      submitter: {
        name: row.submitterName,
        id: row.submitterId,
        contactName: row.submitterContactName,
        contactPhone: row.submitterContactPhone,
      },
      receiver,
    };
  };
}
