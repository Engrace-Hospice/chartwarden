// #671 — per-tenant, per-payer-program switch for accepting an 835 whose payee is identified only by tax id
// (N103=FI) by comparing that TIN to the provider entity's. Default is REFUSE: nothing is allowed unless the
// operator names the tenant and program. Config lives in env (like DOSESPOT_TENANT_CONFIGS), so there is no table,
// migration or tenant-writable surface: a tenant admin cannot widen what the platform accepts.
//
//   M25_PAYEE_TIN_POLICY={"<organizationId uuid>":["medicaid","commercial"]}
//
// A malformed value throws at boot: a typo must be loud, and the safe default (refuse) is what an unset variable gives.
import type { PayeeTinPolicy } from "./service-drizzle";

export const M25_PAYEE_TIN_POLICY_ENV = "M25_PAYEE_TIN_POLICY";
const PAYER_KINDS: ReadonlySet<string> = new Set(["medicare", "medicaid", "commercial"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parsePayeeTinPolicy(raw: string | undefined): PayeeTinPolicy {
  if (!raw?.trim()) return () => false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${M25_PAYEE_TIN_POLICY_ENV} is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(
      `${M25_PAYEE_TIN_POLICY_ENV} must be an object of organizationId -> payer kinds`,
    );
  const allowed = new Map<string, ReadonlySet<string>>();
  for (const [org, kinds] of Object.entries(parsed)) {
    if (!UUID.test(org))
      throw new Error(`${M25_PAYEE_TIN_POLICY_ENV} key is not an organization uuid`);
    if (!Array.isArray(kinds) || kinds.some((k) => typeof k !== "string" || !PAYER_KINDS.has(k)))
      throw new Error(`${M25_PAYEE_TIN_POLICY_ENV} lists an unknown payer kind`);
    allowed.set(org.toLowerCase(), new Set(kinds as string[]));
  }
  return (organizationId, payerKind) =>
    allowed.get(organizationId.toLowerCase())?.has(payerKind) ?? false;
}
