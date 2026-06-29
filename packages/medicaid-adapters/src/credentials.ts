// @wardenx/medicaid-adapters — the adapter-facing trading-partner credential shape (§3.3
// state_medicaid_trading_partner_credential, §4.5). The backend decrypts the KMS-wrapped *_cipher columns
// under the per-tenant DEK at the call site only and hands the adapter this PLAIN, request-scoped value;
// the adapter never touches the DB or the cipher. PURE DOMAIN: a type only.
import type { McoId, MedicaidChannel, ProviderEntityId, StateCode } from "./contracts";

export interface TradingPartnerCredentials {
  readonly providerEntityId: ProviderEntityId;
  readonly serviceState: StateCode;
  readonly channel: MedicaidChannel;
  /** The specific MCO/CCO when channel === 'cco_clearinghouse'. */
  readonly mcoId: McoId | null;
  /** State-assigned submitter id. */
  readonly tradingPartnerId: string;
  readonly clientId: string | null;
  /** Decrypted secret — present only for the duration of the request (never logged/audited). */
  readonly clientSecret: string | null;
  readonly sftpHost: string | null;
  readonly sftpUser: string | null;
  readonly sftpKey: string | null;
  readonly portalUrl: string | null;
  /** Adapter-specific decrypted config blob. */
  readonly additionalConfig: Readonly<Record<string, unknown>> | null;
}
