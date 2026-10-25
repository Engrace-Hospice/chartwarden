// @chartwarden/x12-837-client — Episode Alert DDE wire mapping (#759, ADR-0103 D7). THE ONLY FILE THAT MAY KNOW THE
// VENDOR'S WIRE FORMAT. Everything here is UNVERIFIED because nothing public documents it: no endpoint path, no
// authentication scheme, no request or response field names, no way to key under an operator's own DDE ID, no sandbox.
// Episode Alert gives its guide and sample calls only after signup (14-day trial), and the questions that would settle
// this (ADR-0103 D7, docs/audits/clearinghouse-integration/EPISODE_ALERT_QUESTIONS_TO_SEND_20261025.md) are unanswered.
//
// So this file invents nothing. Every builder and parser below answers `unverified`, and `verified` is false, which is
// what keeps `DDE_PROVIDER=episode_alert` refusing to bind (see ./episode-alert-dde-provider). To finish the adapter once
// the documentation is in hand:
//   1. fill `EA_DDE_FACTS` from the vendor guide (each entry names the question that answers it);
//   2. implement the six functions of {@link EpisodeAlertDdeWire} in this file, nothing else;
//   3. flip `verified` to true only after ./episode-alert-dde-contract.test.ts passes against the trial account;
//   4. register the factory in apps/backend/src/index.ts (`bindDdeProvider(process.env, { episode_alert: ... })`).
import type { Page } from "../clearinghouse/types";
import type { DdeContext, DdeOperation, DdeOperationStatus, DdeOutcome, DdeReceipt } from "./types";

/** What a wire function answers when the format is not known. A stable code, never vendor text. */
export const WIRE_UNVERIFIED = "EA_DDE_WIRE_UNVERIFIED" as const;

export type WireResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: typeof WIRE_UNVERIFIED | "EA_DDE_WIRE_UNREADABLE" };

/** `secret` is the platform credential: the wire decides where it goes (header, query); it must never be logged. */
/** One HTTP call the provider should make. The body may carry PHI (it is never logged or echoed). */
export interface WireRequest {
  /** Path relative to the configured base URL. */
  readonly path: string;
  readonly method: "GET" | "POST";
  /** Extra headers (the credential header lives here). Never logged. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** The vendor facts the adapter depends on, each with the question that settles it. All unknown. */
export const EA_DDE_FACTS = {
  /** D7: are NOE/NOTR, RTP correction, cancel, adjustment API operations at all? */
  writeOperationsExist: null as boolean | null,
  /** D7: can it key under each operator's own DDE ID (ADR-0103 D4)? If a single vendor session, stop and revisit D4. */
  perOperatorDdeId: null as boolean | null,
  /** D7: a sandbox, and how it is selected (the port requires usage "test" to reach only vendor test mode). */
  sandbox: null as string | null,
  /** D7: poll or push for outcomes; the daily change report's paging and cursor shape. */
  changeReport: null as string | null,
  /** The authentication scheme and header. */
  auth: null as string | null,
  /** How an idempotency key is carried (the port requires a replay to send nothing twice). */
  idempotency: null as string | null,
} as const;

export interface EpisodeAlertDdeWire {
  /** True only when every fact above is recorded AND the contract kit passes against the vendor. */
  readonly verified: boolean;
  buildSubmit(secret: string, ctx: DdeContext, op: DdeOperation): WireResult<WireRequest>;
  parseReceipt(body: string, op: DdeOperation): WireResult<DdeReceipt>;
  buildChangeReport(
    secret: string,
    ctx: DdeContext,
    cursor: string | null,
  ): WireResult<WireRequest>;
  parseChangeReport(body: string): WireResult<Page<DdeOutcome>>;
  buildStatus(secret: string, ctx: DdeContext, providerReference: string): WireResult<WireRequest>;
  parseStatus(body: string, providerReference: string): WireResult<DdeOperationStatus>;
}

const unverified = <T>(): WireResult<T> => ({ ok: false, code: WIRE_UNVERIFIED });

export const EA_DDE_WIRE: EpisodeAlertDdeWire = {
  verified: false,
  buildSubmit: () => unverified(),
  parseReceipt: () => unverified(),
  buildChangeReport: () => unverified(),
  parseChangeReport: () => unverified(),
  buildStatus: () => unverified(),
  parseStatus: () => unverified(),
};
