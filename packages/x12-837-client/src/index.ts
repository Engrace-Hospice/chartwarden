// @wardenx/x12-837-client — M23-owned TypeScript client to the Python `x12-worker` sidecar (pyx12).
//
// PACKAGE NAMING: the M23 spec calls this `packages/x12-worker-client`; the locked manifest + scaffold
// use `packages/x12-837-client` (architecture wins). ALL of M23's X12 sidecar client code lives here;
// map every spec reference of "x12-worker-client" to this package.
//
// This is the ONLY place outside the Python `x12-worker` sidecar where X12 wire-format work is reached
// and the ONLY place where MAC portal URLs / endpoints / credentials are named (architecture §25.14
// adapter mandate, spec §8.5). dependency-cruiser (task 20) will forbid `@anthropic-ai/sdk` here and
// forbid one `mac-portal/<juris>` module importing another — the jurisdiction modules are independent.
//
// Barrel discipline: the shared CONTRACT comes from ./types (the extracted leaf). Concrete values are
// re-exported from ./client and ./mac-portal/*, all of which import ONLY from ./types — never from this
// index — so the no-circular fitness rule (the M27 index↔client cycle gotcha) holds.

// ─── Shared adapter CONTRACT (from ./types) ─────────────────────────────────────────────────────
export {
  degraded,
  LAUNCH_JURISDICTION,
  MAC_PORTAL_NOT_WIRED,
  NotImplementedError,
  X12_WORKER_NOT_WIRED,
} from "./types";
export type {
  AckError,
  AckOutcome,
  ClaimAckStatus,
  DegradedError,
  Eligibility270Request,
  Eligibility271Result,
  EligibilityOutcome,
  Generate837iNoeRequest,
  Generate837iNotrRequest,
  Generate837iRequest,
  Generated837i,
  MacJurisdiction,
  MacPortalClient,
  MacPortalReceipt,
  MacPortalStatus,
  MacPortalStatusRequest,
  MacPortalStatusState,
  MacPortalSubmitRequest,
  Parse277caRequest,
  Parse999Request,
  Parsed277ca,
  Parsed999,
  SubmitterContext,
  X12WorkerClient,
  X12WorkerResult,
} from "./types";

// ─── The X12 worker client shape + fail-closed factory (from ./client) ──────────────────────────
export {
  createX12WorkerClient,
  LiveX12WorkerClient,
  NO_X12_WORKER_PORT,
  x12WorkerClient,
} from "./client";
export type {
  X12WorkerClientDeps,
  X12WorkerClientFactory,
  X12WorkerHttpPort,
  X12WorkerHttpRequest,
  X12WorkerHttpResponse,
} from "./client";

// ─── MAC portal clients — launch case + six deny-stubs (from ./mac-portal/*) ─────────────────────
export { createNgsJ6PortalClient, NgsJ6PortalClient } from "./mac-portal/ngs-j6";
export { createNgsJkPortalClient, NgsJkPortalClient } from "./mac-portal/ngs-jk";
export { createCgsJ15PortalClient, CgsJ15PortalClient } from "./mac-portal/cgs-j15";
export { createPalmettoJjPortalClient, PalmettoJjPortalClient } from "./mac-portal/palmetto-jj";
export { createPalmettoJmPortalClient, PalmettoJmPortalClient } from "./mac-portal/palmetto-jm";
export { createNoridianJfPortalClient, NoridianJfPortalClient } from "./mac-portal/noridian-jf";
export { createNoridianJePortalClient, NoridianJePortalClient } from "./mac-portal/noridian-je";
